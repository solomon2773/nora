// @ts-nocheck
const db = require("./db");
const { decrypt, encrypt, ensureEncryptionConfigured } = require("./crypto");

const DEFAULT_DEPLOYMENT_DEFAULTS = Object.freeze({
  vcpu: 1,
  ram_mb: 1024,
  disk_gb: 10,
});
const DEFAULT_SYSTEM_BANNER = Object.freeze({
  enabled: false,
  severity: "warning",
  title: "",
  message: "",
});
const SUPPORTED_LOCALES = Object.freeze(["en", "es", "fr", "zh-Hans", "zh-Hant"]);
const DEFAULT_LANGUAGE_SETTINGS = Object.freeze({
  defaultLocale: "en",
});
const DEFAULT_AGENT_HUB_SETTINGS = Object.freeze({
  defaultShareTarget: "both",
  url: "https://norafleet.ai",
  sourceApiKeyEncrypted: null,
});
const DEFAULT_BACKUP_SETTINGS = Object.freeze({
  storageBackend: "local",
  localPath: "/var/lib/nora-backups",
  s3Bucket: "",
  s3Region: "us-east-1",
  s3Endpoint: "",
  s3AccessKeyIdEncrypted: null,
  s3SecretAccessKeyEncrypted: null,
  sshHost: "",
  sshPort: 22,
  sshUsername: "",
  sshRemotePath: "/backups/nora",
  sshPrivateKeyEncrypted: null,
  sshPasswordEncrypted: null,
  installationScheduleEnabled: false,
  installationScheduleFrequency: "daily",
  installationScheduleHourUtc: 2,
  installationScheduleDayOfWeek: 0,
});
// Platform-wide SMTP for invitation emails + alert email channels (Phase 6).
// Stored as additional columns on platform_settings; the password is encrypted
// at rest via crypto.ts. mailer.ts treats "configured" as host + port +
// from_address all populated.
const DEFAULT_SMTP_SETTINGS = Object.freeze({
  smtpHost: "",
  smtpPort: 587,
  smtpSecure: false,
  smtpUsername: "",
  smtpPasswordEncrypted: null,
  smtpFromAddress: "",
  smtpFromName: "Nora",
});

const BACKUP_PLAN_KEYS = Object.freeze(["free", "pro", "enterprise"]);
const DEFAULT_BACKUP_PLAN_LIMITS = Object.freeze({
  free: Object.freeze({
    managed_backups_enabled: false,
    backup_limit_per_agent: 0,
    backup_storage_mb: 0,
    backup_retention_days: 0,
  }),
  pro: Object.freeze({
    managed_backups_enabled: true,
    backup_limit_per_agent: 5,
    backup_storage_mb: 5120,
    backup_retention_days: 30,
  }),
  enterprise: Object.freeze({
    managed_backups_enabled: true,
    backup_limit_per_agent: 30,
    backup_storage_mb: 102400,
    backup_retention_days: 180,
  }),
});
const SYSTEM_BANNER_SEVERITIES = new Set(["warning", "critical"]);
const SUPPORTED_LOCALE_SET = new Set(SUPPORTED_LOCALES);
const AGENT_HUB_SHARE_TARGETS = new Set(["internal", "community", "both"]);
const BACKUP_STORAGE_BACKENDS = new Set(["local", "s3", "r2", "ssh"]);
const BACKUP_SCHEDULE_FREQUENCIES = new Set(["hourly", "daily", "weekly"]);

// Shared normalization and validation

function parseInteger(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseBoolean(value, fallback = false) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "off", ""].includes(normalized)) return false;
  }
  return fallback;
}

function clampInteger(value, min, max = Number.MAX_SAFE_INTEGER) {
  return Math.min(max, Math.max(min, value));
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeLocale(value, fallback = DEFAULT_LANGUAGE_SETTINGS.defaultLocale) {
  const normalized = normalizeText(value);
  return SUPPORTED_LOCALE_SET.has(normalized) ? normalized : fallback;
}

function parseRequiredLocale(value, fieldName = "locale", { allowNull = false } = {}) {
  if (value === null && allowNull) return null;
  const normalized = normalizeText(value);
  if (!SUPPORTED_LOCALE_SET.has(normalized)) {
    const error = new Error(`${fieldName} must be one of ${SUPPORTED_LOCALES.join(", ")}`);
    error.statusCode = 400;
    throw error;
  }
  return normalized;
}

function normalizeSecretEnv(value) {
  if (value === undefined || value === null) return "";
  const raw = String(value);
  return raw.trim() ? raw : "";
}

function normalizePrivateKeyEnv(value) {
  const normalized = normalizeSecretEnv(value);
  return normalized ? normalized.replace(/\\n/g, "\n") : "";
}

function normalizeUrl(value, fallback = DEFAULT_AGENT_HUB_SETTINGS.url) {
  const normalized = normalizeText(value);
  if (!normalized) return fallback;
  try {
    const parsed = new URL(normalized);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return fallback;
    parsed.pathname = parsed.pathname.replace(/\/+$/, "");
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return fallback;
  }
}

function normalizeBackupStorageBackend(value, fallback = DEFAULT_BACKUP_SETTINGS.storageBackend) {
  const normalized = normalizeText(value).toLowerCase();
  return BACKUP_STORAGE_BACKENDS.has(normalized) ? normalized : fallback;
}

function normalizeBackupRegion(value, storageBackend, fallback = DEFAULT_BACKUP_SETTINGS.s3Region) {
  const normalized = normalizeText(value);
  if (storageBackend === "r2") {
    if (!normalized || normalized === DEFAULT_BACKUP_SETTINGS.s3Region) return "auto";
    return normalized;
  }
  return normalized || fallback;
}

function normalizeBackupFrequency(
  value,
  fallback = DEFAULT_BACKUP_SETTINGS.installationScheduleFrequency,
) {
  const normalized = normalizeText(value).toLowerCase();
  return BACKUP_SCHEDULE_FREQUENCIES.has(normalized) ? normalized : fallback;
}

function parseJsonObject(value, fallback = {}) {
  if (value == null) return fallback;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : fallback;
    } catch {
      return fallback;
    }
  }
  return typeof value === "object" && !Array.isArray(value) ? value : fallback;
}

// Backup settings normalization

function normalizeBackupSettings(input = {}, fallback = DEFAULT_BACKUP_SETTINGS) {
  const storageBackend = normalizeBackupStorageBackend(
    input.backup_storage_backend ?? input.storageBackend,
    fallback.storageBackend,
  );
  return {
    storageBackend,
    localPath: normalizeText(input.backup_local_path ?? input.localPath) || fallback.localPath,
    s3Bucket: normalizeText(input.backup_s3_bucket ?? input.s3Bucket),
    s3Region: normalizeBackupRegion(
      input.backup_s3_region ?? input.s3Region,
      storageBackend,
      fallback.s3Region,
    ),
    s3Endpoint: normalizeText(input.backup_s3_endpoint ?? input.s3Endpoint),
    s3AccessKeyIdEncrypted:
      input.backup_s3_access_key_id_encrypted ??
      input.s3AccessKeyIdEncrypted ??
      fallback.s3AccessKeyIdEncrypted ??
      null,
    s3SecretAccessKeyEncrypted:
      input.backup_s3_secret_access_key_encrypted ??
      input.s3SecretAccessKeyEncrypted ??
      fallback.s3SecretAccessKeyEncrypted ??
      null,
    sshHost: normalizeText(input.backup_ssh_host ?? input.sshHost),
    sshPort: clampInteger(
      parseInteger(input.backup_ssh_port ?? input.sshPort) ?? fallback.sshPort,
      1,
      65535,
    ),
    sshUsername: normalizeText(input.backup_ssh_username ?? input.sshUsername),
    sshRemotePath:
      normalizeText(input.backup_ssh_remote_path ?? input.sshRemotePath) || fallback.sshRemotePath,
    sshPrivateKeyEncrypted:
      input.backup_ssh_private_key_encrypted ??
      input.sshPrivateKeyEncrypted ??
      fallback.sshPrivateKeyEncrypted ??
      null,
    sshPasswordEncrypted:
      input.backup_ssh_password_encrypted ??
      input.sshPasswordEncrypted ??
      fallback.sshPasswordEncrypted ??
      null,
    installationScheduleEnabled: parseBoolean(
      input.backup_installation_schedule_enabled ?? input.installationScheduleEnabled,
      fallback.installationScheduleEnabled,
    ),
    installationScheduleFrequency: normalizeBackupFrequency(
      input.backup_installation_schedule_frequency ?? input.installationScheduleFrequency,
      fallback.installationScheduleFrequency,
    ),
    installationScheduleHourUtc: clampInteger(
      parseInteger(
        input.backup_installation_schedule_hour_utc ?? input.installationScheduleHourUtc,
      ) ?? fallback.installationScheduleHourUtc,
      0,
      23,
    ),
    installationScheduleDayOfWeek: clampInteger(
      parseInteger(
        input.backup_installation_schedule_day_of_week ?? input.installationScheduleDayOfWeek,
      ) ?? fallback.installationScheduleDayOfWeek,
      0,
      6,
    ),
  };
}

function normalizeBackupPlanLimitEntry(input = {}, fallback = {}) {
  return {
    managed_backups_enabled: parseBoolean(
      input.managed_backups_enabled ?? input.managedBackupsEnabled,
      fallback.managed_backups_enabled,
    ),
    backup_limit_per_agent:
      parseInteger(input.backup_limit_per_agent ?? input.backupLimitPerAgent) ??
      fallback.backup_limit_per_agent,
    backup_storage_mb:
      parseInteger(input.backup_storage_mb ?? input.backupStorageMb) ?? fallback.backup_storage_mb,
    backup_retention_days:
      parseInteger(input.backup_retention_days ?? input.backupRetentionDays) ??
      fallback.backup_retention_days,
  };
}

// Read-side normalize: forgive on missing/malformed input by falling back to
// DEFAULT_BACKUP_PLAN_LIMITS per-key. Callers pass the raw JSONB value from
// the platform_settings.backup_plan_limits column (or null/undefined for
// the default-only path).
function normalizeBackupPlanLimits(input) {
  const source = parseJsonObject(input, {});
  return BACKUP_PLAN_KEYS.reduce((limits, plan) => {
    limits[plan] = normalizeBackupPlanLimitEntry(
      source[plan] || {},
      DEFAULT_BACKUP_PLAN_LIMITS[plan],
    );
    return limits;
  }, {});
}

function maskSecret(value) {
  const normalized = normalizeText(value);
  if (!normalized) return "";
  if (normalized.length <= 12) return `${normalized.slice(0, 4)}...`;
  return `${normalized.slice(0, 10)}...${normalized.slice(-4)}`;
}

// ─── Platform SMTP (Phase 6) ────────────────────────────────────────────────

function normalizeSmtpSettings(input = {}, fallback = DEFAULT_SMTP_SETTINGS) {
  return {
    smtpHost: normalizeText(input.smtp_host ?? input.smtpHost) || fallback.smtpHost,
    smtpPort: clampInteger(
      parseInteger(input.smtp_port ?? input.smtpPort) ?? fallback.smtpPort,
      1,
      65535,
    ),
    smtpSecure: parseBoolean(input.smtp_secure ?? input.smtpSecure, fallback.smtpSecure),
    smtpUsername: normalizeText(input.smtp_username ?? input.smtpUsername) || fallback.smtpUsername,
    smtpPasswordEncrypted:
      input.smtp_password_encrypted ??
      input.smtpPasswordEncrypted ??
      fallback.smtpPasswordEncrypted ??
      null,
    smtpFromAddress:
      normalizeText(input.smtp_from_address ?? input.smtpFromAddress) || fallback.smtpFromAddress,
    smtpFromName:
      normalizeText(input.smtp_from_name ?? input.smtpFromName) || fallback.smtpFromName,
  };
}

// RFC 5321 caps an address at 254 chars; rejecting longer input first stops
// the regex from chewing on attacker-supplied unbounded strings.
const EMAIL_MAX_LENGTH = 254;

function looksLikeEmail(value) {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > EMAIL_MAX_LENGTH) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed);
}

function parseRequiredSmtpSettings(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    const error = new Error("smtp settings payload must be an object");
    error.statusCode = 400;
    throw error;
  }
  const port = clampInteger(
    parseInteger(input.smtpPort ?? input.smtp_port) ?? DEFAULT_SMTP_SETTINGS.smtpPort,
    1,
    65535,
  );
  const fromAddress = normalizeText(input.smtpFromAddress ?? input.smtp_from_address);
  if (fromAddress && !looksLikeEmail(fromAddress)) {
    const error = new Error("smtpFromAddress must be a valid email address");
    error.statusCode = 400;
    throw error;
  }
  return {
    smtpHost: normalizeText(input.smtpHost ?? input.smtp_host),
    smtpPort: port,
    // Auto-true when port=465 (SMTPS); otherwise honor admin's flag.
    smtpSecure: port === 465 ? true : parseBoolean(input.smtpSecure ?? input.smtp_secure, false),
    smtpUsername: normalizeText(input.smtpUsername ?? input.smtp_username),
    smtpPassword:
      input.smtpPassword === undefined || input.smtpPassword === null
        ? undefined
        : String(input.smtpPassword),
    clearSmtpPassword: parseBoolean(input.clearSmtpPassword, false),
    smtpFromAddress: fromAddress,
    smtpFromName:
      normalizeText(input.smtpFromName ?? input.smtp_from_name) ||
      DEFAULT_SMTP_SETTINGS.smtpFromName,
  };
}

function resolveSmtpSettingsPayload(settings) {
  let storedPasswordMasked = "";
  try {
    if (settings.smtpPasswordEncrypted) {
      storedPasswordMasked = maskSecret(decrypt(settings.smtpPasswordEncrypted));
    }
  } catch {
    // Swallow decryption errors — the column is corrupt or the encryption
    // key changed. Surfacing this as a startup error is the wrong tradeoff;
    // the admin UI shows the password slot as empty so they can re-enter.
    storedPasswordMasked = "";
  }
  return {
    smtpHost: settings.smtpHost,
    smtpPort: settings.smtpPort,
    smtpSecure: settings.smtpSecure,
    smtpUsername: settings.smtpUsername,
    smtpFromAddress: settings.smtpFromAddress,
    smtpFromName: settings.smtpFromName,
    smtpPasswordMasked: storedPasswordMasked,
    smtpConfigured: Boolean(settings.smtpHost && settings.smtpPort && settings.smtpFromAddress),
  };
}

// Deployment, locale, and banner normalization

function normalizeDeploymentDefaults(input = {}, fallback = DEFAULT_DEPLOYMENT_DEFAULTS) {
  return {
    vcpu: parseInteger(input.vcpu ?? input.default_vcpu) ?? fallback.vcpu,
    ram_mb: parseInteger(input.ram_mb ?? input.default_ram_mb) ?? fallback.ram_mb,
    disk_gb: parseInteger(input.disk_gb ?? input.default_disk_gb) ?? fallback.disk_gb,
  };
}

function normalizeLanguageSettings(input = {}, fallback = DEFAULT_LANGUAGE_SETTINGS) {
  return {
    defaultLocale: normalizeLocale(
      input.default_locale ?? input.defaultLocale,
      fallback.defaultLocale,
    ),
  };
}

function resolveLanguageSettingsPayload(input = {}) {
  const settings = normalizeLanguageSettings(input);
  return {
    defaultLocale: settings.defaultLocale,
    supportedLocales: [...SUPPORTED_LOCALES],
  };
}

function resolvePreferredLocale(
  preferredLocale,
  defaultLocale = DEFAULT_LANGUAGE_SETTINGS.defaultLocale,
) {
  return normalizeLocale(preferredLocale, normalizeLocale(defaultLocale));
}

function clampDeploymentDefaults(defaults = {}, limits = {}) {
  const normalized = normalizeDeploymentDefaults(defaults);
  return {
    vcpu: clampInteger(normalized.vcpu, 1, limits.max_vcpu),
    ram_mb: clampInteger(normalized.ram_mb, 512, limits.max_ram_mb),
    disk_gb: clampInteger(normalized.disk_gb, 1, limits.max_disk_gb),
  };
}

function parseRequiredDeploymentDefaults(input = {}) {
  const next = {};
  for (const key of ["vcpu", "ram_mb", "disk_gb"]) {
    const value = parseInteger(input[key]);
    if (value == null) {
      const error = new Error(`${key} must be an integer`);
      error.statusCode = 400;
      throw error;
    }
    next[key] = value;
  }
  return next;
}

function parseRequiredLanguageSettings(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    const error = new Error("language settings payload must be an object");
    error.statusCode = 400;
    throw error;
  }

  return {
    defaultLocale: parseRequiredLocale(
      input.defaultLocale ?? input.default_locale,
      "defaultLocale",
    ),
  };
}

function isSystemBannerFeatureEnabled() {
  return parseBoolean(process.env.NORA_SYSTEM_BANNER_ENABLED, false);
}

function normalizeSystemBanner(input = {}, fallback = DEFAULT_SYSTEM_BANNER) {
  const requestedSeverity = normalizeText(
    input.system_banner_severity ?? input.severity,
  ).toLowerCase();
  return {
    enabled: parseBoolean(input.system_banner_enabled ?? input.enabled, fallback.enabled),
    severity: SYSTEM_BANNER_SEVERITIES.has(requestedSeverity)
      ? requestedSeverity
      : fallback.severity,
    title: normalizeText(input.system_banner_title ?? input.title),
    message: normalizeText(input.system_banner_message ?? input.message),
  };
}

function resolveSystemBannerPayload(input = {}) {
  const normalized = normalizeSystemBanner(input);
  const featureEnabled = isSystemBannerFeatureEnabled();
  const hasContent = Boolean(normalized.title && normalized.message);
  return {
    ...normalized,
    featureEnabled,
    active: featureEnabled && normalized.enabled && hasContent,
  };
}

function parseRequiredSystemBanner(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    const error = new Error("system banner payload must be an object");
    error.statusCode = 400;
    throw error;
  }

  const rawSeverity = normalizeText(input.severity).toLowerCase();
  if (rawSeverity && !SYSTEM_BANNER_SEVERITIES.has(rawSeverity)) {
    const error = new Error("severity must be warning or critical");
    error.statusCode = 400;
    throw error;
  }

  const title = normalizeText(input.title);
  const message = normalizeText(input.message);
  if (title.length > 120) {
    const error = new Error("title must be 120 characters or fewer");
    error.statusCode = 400;
    throw error;
  }
  if (message.length > 600) {
    const error = new Error("message must be 600 characters or fewer");
    error.statusCode = 400;
    throw error;
  }

  const next = {
    enabled: parseBoolean(input.enabled, false),
    severity: rawSeverity || DEFAULT_SYSTEM_BANNER.severity,
    title,
    message,
  };

  if (next.enabled && !next.title) {
    const error = new Error("title is required when the system banner is enabled");
    error.statusCode = 400;
    throw error;
  }
  if (next.enabled && !next.message) {
    const error = new Error("message is required when the system banner is enabled");
    error.statusCode = 400;
    throw error;
  }

  return next;
}

// Agent Hub and backup response shaping

function normalizeAgentHubSettings(input = {}, fallback = DEFAULT_AGENT_HUB_SETTINGS) {
  const rawShareTarget = normalizeText(
    input.agent_hub_default_share_target ?? input.defaultShareTarget,
  ).toLowerCase();
  const defaultShareTarget = AGENT_HUB_SHARE_TARGETS.has(rawShareTarget)
    ? rawShareTarget
    : fallback.defaultShareTarget;

  return {
    defaultShareTarget,
    url: normalizeUrl(input.agent_hub_url ?? input.url, fallback.url),
    sourceApiKeyEncrypted:
      input.agent_hub_api_key_encrypted ??
      input.sourceApiKeyEncrypted ??
      fallback.sourceApiKeyEncrypted ??
      null,
  };
}

/**
 * Build admin-safe Agent Hub settings with secret source and masking metadata,
 * preferring an environment key over encrypted database state.
 *
 * @param {Object} settings - Normalized stored Agent Hub settings.
 * @returns {Object} Public settings payload without raw credentials.
 */
function resolveAgentHubSettingsPayload(settings) {
  const envApiKey = normalizeText(process.env.NORA_AGENT_HUB_API_KEY);
  let storedApiKeyMasked = "";
  if (settings.sourceApiKeyEncrypted) {
    try {
      storedApiKeyMasked = maskSecret(decrypt(settings.sourceApiKeyEncrypted));
    } catch {
      storedApiKeyMasked = "unreadable";
    }
  }
  const hasStoredApiKey = Boolean(settings.sourceApiKeyEncrypted);
  return {
    defaultShareTarget: settings.defaultShareTarget,
    url: settings.url,
    envUrl: normalizeUrl(process.env.NORA_AGENT_HUB_URL, settings.url),
    sourceApiKeyConfigured: Boolean(envApiKey || hasStoredApiKey),
    sourceApiKeySource: envApiKey ? "env" : hasStoredApiKey ? "database" : "none",
    sourceApiKeyMasked: envApiKey ? maskSecret(envApiKey) : storedApiKeyMasked,
  };
}

/**
 * Build admin-safe backup settings with environment precedence and masked
 * credential status instead of decrypted operational secrets.
 *
 * @param {Object} settings - Normalized stored backup settings.
 * @returns {Object} Public backup settings payload.
 */
function resolveBackupSettingsPayload(settings) {
  const envBackend = normalizeText(process.env.NORA_BACKUP_STORAGE);
  const storageBackend = envBackend
    ? normalizeBackupStorageBackend(envBackend)
    : settings.storageBackend;
  const envS3Key = normalizeText(
    process.env.NORA_BACKUP_S3_ACCESS_KEY_ID ||
      process.env.NORA_BACKUP_R2_ACCESS_KEY_ID ||
      process.env.AWS_ACCESS_KEY_ID,
  );
  const envS3Secret = normalizeText(
    process.env.NORA_BACKUP_S3_SECRET_ACCESS_KEY ||
      process.env.NORA_BACKUP_R2_SECRET_ACCESS_KEY ||
      process.env.AWS_SECRET_ACCESS_KEY,
  );
  const envSshPrivateKey = normalizePrivateKeyEnv(process.env.NORA_BACKUP_SSH_PRIVATE_KEY);
  const envSshPassword = normalizeSecretEnv(process.env.NORA_BACKUP_SSH_PASSWORD);
  let storedS3KeyMasked = "";
  let storedS3SecretMasked = "";
  let storedSshPrivateKeyMasked = "";
  let storedSshPasswordMasked = "";
  try {
    if (settings.s3AccessKeyIdEncrypted)
      storedS3KeyMasked = maskSecret(decrypt(settings.s3AccessKeyIdEncrypted));
    if (settings.s3SecretAccessKeyEncrypted)
      storedS3SecretMasked = maskSecret(decrypt(settings.s3SecretAccessKeyEncrypted));
    if (settings.sshPrivateKeyEncrypted) storedSshPrivateKeyMasked = "Configured";
    if (settings.sshPasswordEncrypted)
      storedSshPasswordMasked = maskSecret(decrypt(settings.sshPasswordEncrypted));
  } catch {
    storedS3KeyMasked = storedS3KeyMasked || "unreadable";
  }

  return {
    storageBackend,
    storageBackendSource: envBackend ? "env" : "database",
    localPath: normalizeText(process.env.NORA_BACKUP_DIR) || settings.localPath,
    s3Bucket:
      normalizeText(
        process.env.NORA_BACKUP_S3_BUCKET ||
          process.env.NORA_BACKUP_R2_BUCKET ||
          process.env.AWS_S3_BUCKET,
      ) || settings.s3Bucket,
    s3Region: normalizeBackupRegion(
      normalizeText(process.env.NORA_BACKUP_S3_REGION || process.env.NORA_BACKUP_R2_REGION) ||
        settings.s3Region,
      storageBackend,
      settings.s3Region,
    ),
    s3Endpoint:
      normalizeText(process.env.NORA_BACKUP_S3_ENDPOINT || process.env.NORA_BACKUP_R2_ENDPOINT) ||
      settings.s3Endpoint,
    s3AccessKeyConfigured: Boolean(envS3Key || settings.s3AccessKeyIdEncrypted),
    s3AccessKeySource: envS3Key ? "env" : settings.s3AccessKeyIdEncrypted ? "database" : "none",
    s3AccessKeyMasked: envS3Key ? maskSecret(envS3Key) : storedS3KeyMasked,
    s3SecretConfigured: Boolean(envS3Secret || settings.s3SecretAccessKeyEncrypted),
    s3SecretSource: envS3Secret ? "env" : settings.s3SecretAccessKeyEncrypted ? "database" : "none",
    s3SecretMasked: envS3Secret ? maskSecret(envS3Secret) : storedS3SecretMasked,
    sshHost: normalizeText(process.env.NORA_BACKUP_SSH_HOST) || settings.sshHost,
    sshPort: parseInteger(process.env.NORA_BACKUP_SSH_PORT) || settings.sshPort,
    sshUsername: normalizeText(process.env.NORA_BACKUP_SSH_USERNAME) || settings.sshUsername,
    sshRemotePath: normalizeText(process.env.NORA_BACKUP_SSH_REMOTE_PATH) || settings.sshRemotePath,
    sshPrivateKeyConfigured: Boolean(envSshPrivateKey || settings.sshPrivateKeyEncrypted),
    sshPrivateKeySource: envSshPrivateKey
      ? "env"
      : settings.sshPrivateKeyEncrypted
        ? "database"
        : "none",
    sshPrivateKeyMasked: envSshPrivateKey ? "Configured via env" : storedSshPrivateKeyMasked,
    sshPasswordConfigured: Boolean(envSshPassword || settings.sshPasswordEncrypted),
    sshPasswordSource: envSshPassword ? "env" : settings.sshPasswordEncrypted ? "database" : "none",
    sshPasswordMasked: envSshPassword ? maskSecret(envSshPassword) : storedSshPasswordMasked,
    installationScheduleEnabled: settings.installationScheduleEnabled,
    installationScheduleFrequency: settings.installationScheduleFrequency,
    installationScheduleHourUtc: settings.installationScheduleHourUtc,
    installationScheduleDayOfWeek: settings.installationScheduleDayOfWeek,
  };
}

function parseRequiredBackupSettings(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    const error = new Error("backup settings payload must be an object");
    error.statusCode = 400;
    throw error;
  }

  const storageBackend = normalizeBackupStorageBackend(input.storageBackend, "");
  if (!storageBackend) {
    const error = new Error("storageBackend must be local, s3, r2, or ssh");
    error.statusCode = 400;
    throw error;
  }

  const frequency = normalizeBackupFrequency(input.installationScheduleFrequency, "");
  if (input.installationScheduleFrequency && !frequency) {
    const error = new Error("installationScheduleFrequency must be hourly, daily, or weekly");
    error.statusCode = 400;
    throw error;
  }

  return {
    storageBackend,
    localPath: normalizeText(input.localPath) || DEFAULT_BACKUP_SETTINGS.localPath,
    s3Bucket: normalizeText(input.s3Bucket),
    s3Region: normalizeBackupRegion(input.s3Region, storageBackend),
    s3Endpoint: normalizeText(input.s3Endpoint),
    s3AccessKeyId:
      input.s3AccessKeyId === undefined || input.s3AccessKeyId === null
        ? undefined
        : normalizeText(input.s3AccessKeyId),
    s3SecretAccessKey:
      input.s3SecretAccessKey === undefined || input.s3SecretAccessKey === null
        ? undefined
        : normalizeText(input.s3SecretAccessKey),
    clearS3AccessKey: parseBoolean(input.clearS3AccessKey, false),
    clearS3SecretAccessKey: parseBoolean(input.clearS3SecretAccessKey, false),
    sshHost: normalizeText(input.sshHost),
    sshPort: clampInteger(parseInteger(input.sshPort) || DEFAULT_BACKUP_SETTINGS.sshPort, 1, 65535),
    sshUsername: normalizeText(input.sshUsername),
    sshRemotePath: normalizeText(input.sshRemotePath) || DEFAULT_BACKUP_SETTINGS.sshRemotePath,
    sshPrivateKey:
      input.sshPrivateKey === undefined || input.sshPrivateKey === null
        ? undefined
        : String(input.sshPrivateKey).trim(),
    sshPassword:
      input.sshPassword === undefined || input.sshPassword === null
        ? undefined
        : String(input.sshPassword),
    clearSshPrivateKey: parseBoolean(input.clearSshPrivateKey, false),
    clearSshPassword: parseBoolean(input.clearSshPassword, false),
    installationScheduleEnabled: parseBoolean(input.installationScheduleEnabled, false),
    installationScheduleFrequency:
      frequency || DEFAULT_BACKUP_SETTINGS.installationScheduleFrequency,
    installationScheduleHourUtc: clampInteger(
      parseInteger(input.installationScheduleHourUtc) ??
        DEFAULT_BACKUP_SETTINGS.installationScheduleHourUtc,
      0,
      23,
    ),
    installationScheduleDayOfWeek: clampInteger(
      parseInteger(input.installationScheduleDayOfWeek) ??
        DEFAULT_BACKUP_SETTINGS.installationScheduleDayOfWeek,
      0,
      6,
    ),
  };
}

function parseRequiredBackupPlanLimits(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    const error = new Error("backup plan limits payload must be an object");
    error.statusCode = 400;
    throw error;
  }

  const plans = parseJsonObject(
    input.plans ?? input.backupPlanLimits ?? input.backup_plan_limits,
    {},
  );
  return BACKUP_PLAN_KEYS.reduce((limits, plan) => {
    const entry = plans[plan];
    // A missing tier in the payload inherits defaults — admins don't have to
    // resend every tier on each PUT. A present-but-malformed tier is
    // rejected loudly so admins notice the typo.
    if (entry == null) {
      limits[plan] = { ...DEFAULT_BACKUP_PLAN_LIMITS[plan] };
      return limits;
    }
    if (typeof entry !== "object" || Array.isArray(entry)) {
      const error = new Error(`${plan} entry must be an object`);
      error.statusCode = 400;
      throw error;
    }

    const managedBackupsEnabled = parseBoolean(
      entry.managed_backups_enabled ?? entry.managedBackupsEnabled,
      DEFAULT_BACKUP_PLAN_LIMITS[plan].managed_backups_enabled,
    );
    const backupLimitPerAgent = parseInteger(
      entry.backup_limit_per_agent ?? entry.backupLimitPerAgent,
    );
    const backupStorageMb = parseInteger(entry.backup_storage_mb ?? entry.backupStorageMb);
    const backupRetentionDays = parseInteger(
      entry.backup_retention_days ?? entry.backupRetentionDays,
    );

    for (const [field, value] of [
      ["backup_limit_per_agent", backupLimitPerAgent],
      ["backup_storage_mb", backupStorageMb],
      ["backup_retention_days", backupRetentionDays],
    ]) {
      if (!Number.isSafeInteger(value) || value < 0) {
        const error = new Error(`${plan}.${field} must be an integer that is 0 or greater`);
        error.statusCode = 400;
        throw error;
      }
    }

    // Catch the foot-gun where an admin enables the tier but zeroes out one
    // of the limits — that silently bricks every tenant on the tier because
    // capacity checks reject every backup. Either disable the tier or set
    // real limits.
    if (managedBackupsEnabled) {
      for (const [field, value] of [
        ["backup_limit_per_agent", backupLimitPerAgent],
        ["backup_storage_mb", backupStorageMb],
        ["backup_retention_days", backupRetentionDays],
      ]) {
        if (value === 0) {
          const error = new Error(
            `${plan}.${field} must be greater than 0 when managed_backups_enabled is true`,
          );
          error.statusCode = 400;
          throw error;
        }
      }
    }

    limits[plan] = {
      managed_backups_enabled: managedBackupsEnabled,
      backup_limit_per_agent: backupLimitPerAgent,
      backup_storage_mb: backupStorageMb,
      backup_retention_days: backupRetentionDays,
    };
    return limits;
  }, {});
}

function parseRequiredAgentHubSettings(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    const error = new Error("agent hub settings payload must be an object");
    error.statusCode = 400;
    throw error;
  }

  const rawShareTarget = normalizeText(input.defaultShareTarget).toLowerCase();
  if (!AGENT_HUB_SHARE_TARGETS.has(rawShareTarget)) {
    const error = new Error("defaultShareTarget must be internal, community, or both");
    error.statusCode = 400;
    throw error;
  }

  const rawUrl = normalizeText(input.url);
  if (rawUrl.length > 500) {
    const error = new Error("url must be 500 characters or fewer");
    error.statusCode = 400;
    throw error;
  }

  const normalizedUrl = normalizeUrl(rawUrl, "");
  if (!normalizedUrl) {
    const error = new Error("url must be a valid http or https URL");
    error.statusCode = 400;
    throw error;
  }

  const sourceApiKey =
    input.sourceApiKey === undefined || input.sourceApiKey === null
      ? undefined
      : normalizeText(input.sourceApiKey);
  if (sourceApiKey !== undefined && sourceApiKey.length > 1000) {
    const error = new Error("sourceApiKey must be 1000 characters or fewer");
    error.statusCode = 400;
    throw error;
  }

  return {
    defaultShareTarget: rawShareTarget,
    url: normalizedUrl,
    sourceApiKey,
    clearSourceApiKey: parseBoolean(input.clearSourceApiKey, false),
  };
}

// Platform settings reads

async function getDeploymentDefaults() {
  const result = await db.query(
    `SELECT default_vcpu, default_ram_mb, default_disk_gb
       FROM platform_settings
      WHERE singleton = TRUE
      LIMIT 1`,
  );
  return clampDeploymentDefaults(result.rows[0] || DEFAULT_DEPLOYMENT_DEFAULTS);
}

async function getLanguageSettings() {
  const result = await db.query(
    `SELECT default_locale
       FROM platform_settings
      WHERE singleton = TRUE
      LIMIT 1`,
  );
  return resolveLanguageSettingsPayload(result.rows[0] || DEFAULT_LANGUAGE_SETTINGS);
}

async function getSystemBanner() {
  const result = await db.query(
    `SELECT system_banner_enabled,
            system_banner_severity,
            system_banner_title,
            system_banner_message
       FROM platform_settings
      WHERE singleton = TRUE
      LIMIT 1`,
  );

  return resolveSystemBannerPayload(result.rows[0] || DEFAULT_SYSTEM_BANNER);
}

async function getAgentHubSettings() {
  const result = await db.query(
    `SELECT agent_hub_default_share_target,
            agent_hub_url,
            agent_hub_api_key_encrypted
       FROM platform_settings
      WHERE singleton = TRUE
      LIMIT 1`,
  );

  const settings = normalizeAgentHubSettings(result.rows[0] || DEFAULT_AGENT_HUB_SETTINGS);
  return resolveAgentHubSettingsPayload(settings);
}

/**
 * Resolve the Agent Hub source credential with environment configuration taking
 * precedence over the encrypted database value.
 *
 * @returns {Promise<string>} Decrypted source API key, or an empty string.
 */
async function getAgentHubSourceApiKey() {
  const envApiKey = normalizeText(process.env.NORA_AGENT_HUB_API_KEY);
  if (envApiKey) return envApiKey;

  const result = await db.query(
    `SELECT agent_hub_api_key_encrypted
       FROM platform_settings
      WHERE singleton = TRUE
      LIMIT 1`,
  );
  const encrypted = result.rows[0]?.agent_hub_api_key_encrypted;
  return encrypted ? decrypt(encrypted) : "";
}

async function getSmtpSettings() {
  const result = await db.query(
    `SELECT smtp_host, smtp_port, smtp_secure, smtp_username,
            smtp_password_encrypted, smtp_from_address, smtp_from_name
       FROM platform_settings
      WHERE singleton = TRUE
      LIMIT 1`,
  );
  return resolveSmtpSettingsPayload(normalizeSmtpSettings(result.rows[0] || DEFAULT_SMTP_SETTINGS));
}

// SMTP settings persistence and delivery

/**
 * Return SMTP delivery configuration for internal mailers, treating an
 * unreadable encrypted password as empty and missing host/from settings as `null`.
 *
 * @returns {Promise<Object|null>} Operational SMTP configuration.
 */
async function getSmtpDeliveryConfig() {
  const result = await db.query(
    `SELECT smtp_host, smtp_port, smtp_secure, smtp_username,
            smtp_password_encrypted, smtp_from_address, smtp_from_name
       FROM platform_settings
      WHERE singleton = TRUE
      LIMIT 1`,
  );
  const settings = normalizeSmtpSettings(result.rows[0] || DEFAULT_SMTP_SETTINGS);
  if (!settings.smtpHost || !settings.smtpPort || !settings.smtpFromAddress) {
    return null;
  }
  let password = "";
  try {
    if (settings.smtpPasswordEncrypted) password = decrypt(settings.smtpPasswordEncrypted);
  } catch {
    password = "";
  }
  return {
    host: settings.smtpHost,
    port: settings.smtpPort,
    secure: settings.smtpPort === 465 ? true : Boolean(settings.smtpSecure),
    username: settings.smtpUsername,
    password,
    fromAddress: settings.smtpFromAddress,
    fromName: settings.smtpFromName,
  };
}

/**
 * Validate and persist SMTP settings, encrypting a supplied password while
 * preserving or explicitly clearing the existing credential as requested.
 *
 * @param {Object} [settings={}] - Admin SMTP settings and password controls.
 * @returns {Promise<Object>} Admin-safe persisted settings.
 */
async function updateSmtpSettings(settings = {}) {
  const next = parseRequiredSmtpSettings(settings);
  const current = await db.query(
    `SELECT smtp_password_encrypted
       FROM platform_settings
      WHERE singleton = TRUE
      LIMIT 1`,
  );
  let smtpPasswordEncrypted = current.rows[0]?.smtp_password_encrypted || null;
  if (next.clearSmtpPassword) {
    smtpPasswordEncrypted = null;
  } else if (next.smtpPassword !== undefined) {
    if (next.smtpPassword) ensureEncryptionConfigured("Platform SMTP credential storage");
    smtpPasswordEncrypted = next.smtpPassword ? encrypt(next.smtpPassword) : smtpPasswordEncrypted;
  }

  const result = await db.query(
    `INSERT INTO platform_settings(
       singleton, smtp_host, smtp_port, smtp_secure, smtp_username,
       smtp_password_encrypted, smtp_from_address, smtp_from_name, updated_at
     )
     VALUES(TRUE, $1, $2, $3, $4, $5, $6, $7, NOW())
     ON CONFLICT (singleton) DO UPDATE SET
       smtp_host = EXCLUDED.smtp_host,
       smtp_port = EXCLUDED.smtp_port,
       smtp_secure = EXCLUDED.smtp_secure,
       smtp_username = EXCLUDED.smtp_username,
       smtp_password_encrypted = EXCLUDED.smtp_password_encrypted,
       smtp_from_address = EXCLUDED.smtp_from_address,
       smtp_from_name = EXCLUDED.smtp_from_name,
       updated_at = NOW()
     RETURNING smtp_host, smtp_port, smtp_secure, smtp_username,
               smtp_password_encrypted, smtp_from_address, smtp_from_name`,
    [
      next.smtpHost,
      next.smtpPort,
      next.smtpSecure,
      next.smtpUsername,
      smtpPasswordEncrypted,
      next.smtpFromAddress,
      next.smtpFromName,
    ],
  );
  return resolveSmtpSettingsPayload(normalizeSmtpSettings(result.rows[0]));
}

// Backup settings and entitlements

/**
 * Return admin-safe backup settings with environment precedence and masked
 * credential status.
 *
 * @returns {Promise<Object>} Public backup settings payload.
 */
async function getBackupSettings() {
  const result = await db.query(
    `SELECT backup_storage_backend,
            backup_local_path,
            backup_s3_bucket,
            backup_s3_region,
            backup_s3_endpoint,
            backup_s3_access_key_id_encrypted,
            backup_s3_secret_access_key_encrypted,
            backup_ssh_host,
            backup_ssh_port,
            backup_ssh_username,
            backup_ssh_remote_path,
            backup_ssh_private_key_encrypted,
            backup_ssh_password_encrypted,
            backup_installation_schedule_enabled,
            backup_installation_schedule_frequency,
            backup_installation_schedule_hour_utc,
            backup_installation_schedule_day_of_week
       FROM platform_settings
      WHERE singleton = TRUE
      LIMIT 1`,
  );

  return resolveBackupSettingsPayload(
    normalizeBackupSettings(result.rows[0] || DEFAULT_BACKUP_SETTINGS),
  );
}

/**
 * Resolve decrypted operational backup configuration for backup workers,
 * preferring non-empty environment credentials over encrypted database values.
 *
 * @returns {Promise<Object>} Internal storage configuration including raw credentials.
 */
async function getBackupStorageConfig() {
  const result = await db.query(
    `SELECT backup_storage_backend,
            backup_local_path,
            backup_s3_bucket,
            backup_s3_region,
            backup_s3_endpoint,
            backup_s3_access_key_id_encrypted,
            backup_s3_secret_access_key_encrypted,
            backup_ssh_host,
            backup_ssh_port,
            backup_ssh_username,
            backup_ssh_remote_path,
            backup_ssh_private_key_encrypted,
            backup_ssh_password_encrypted,
            backup_installation_schedule_enabled,
            backup_installation_schedule_frequency,
            backup_installation_schedule_hour_utc,
            backup_installation_schedule_day_of_week
       FROM platform_settings
      WHERE singleton = TRUE
      LIMIT 1`,
  );
  const settings = normalizeBackupSettings(result.rows[0] || DEFAULT_BACKUP_SETTINGS);
  const backend = normalizeBackupStorageBackend(
    process.env.NORA_BACKUP_STORAGE || settings.storageBackend,
  );
  const envSshPrivateKey = normalizePrivateKeyEnv(process.env.NORA_BACKUP_SSH_PRIVATE_KEY);
  const envSshPassword = normalizeSecretEnv(process.env.NORA_BACKUP_SSH_PASSWORD);

  const decryptMaybe = (encrypted) => (encrypted ? decrypt(encrypted) : "");
  const s3AccessKeyId =
    normalizeText(
      process.env.NORA_BACKUP_S3_ACCESS_KEY_ID ||
        process.env.NORA_BACKUP_R2_ACCESS_KEY_ID ||
        process.env.AWS_ACCESS_KEY_ID,
    ) || decryptMaybe(settings.s3AccessKeyIdEncrypted);
  const s3SecretAccessKey =
    normalizeText(
      process.env.NORA_BACKUP_S3_SECRET_ACCESS_KEY ||
        process.env.NORA_BACKUP_R2_SECRET_ACCESS_KEY ||
        process.env.AWS_SECRET_ACCESS_KEY,
    ) || decryptMaybe(settings.s3SecretAccessKeyEncrypted);

  return {
    ...settings,
    storageBackend: backend,
    localPath: normalizeText(process.env.NORA_BACKUP_DIR) || settings.localPath,
    s3Bucket:
      normalizeText(
        process.env.NORA_BACKUP_S3_BUCKET ||
          process.env.NORA_BACKUP_R2_BUCKET ||
          process.env.AWS_S3_BUCKET,
      ) || settings.s3Bucket,
    s3Region: normalizeBackupRegion(
      normalizeText(process.env.NORA_BACKUP_S3_REGION || process.env.NORA_BACKUP_R2_REGION) ||
        settings.s3Region,
      backend,
      settings.s3Region,
    ),
    s3Endpoint:
      normalizeText(process.env.NORA_BACKUP_S3_ENDPOINT || process.env.NORA_BACKUP_R2_ENDPOINT) ||
      settings.s3Endpoint,
    s3AccessKeyId,
    s3SecretAccessKey,
    s3SessionToken: normalizeText(
      process.env.NORA_BACKUP_S3_SESSION_TOKEN ||
        process.env.NORA_BACKUP_R2_SESSION_TOKEN ||
        process.env.AWS_SESSION_TOKEN,
    ),
    sshHost: normalizeText(process.env.NORA_BACKUP_SSH_HOST) || settings.sshHost,
    sshPort: parseInteger(process.env.NORA_BACKUP_SSH_PORT) || settings.sshPort,
    sshUsername: normalizeText(process.env.NORA_BACKUP_SSH_USERNAME) || settings.sshUsername,
    sshRemotePath: normalizeText(process.env.NORA_BACKUP_SSH_REMOTE_PATH) || settings.sshRemotePath,
    sshPrivateKey: envSshPrivateKey || decryptMaybe(settings.sshPrivateKeyEncrypted),
    sshPassword: envSshPassword || decryptMaybe(settings.sshPasswordEncrypted),
  };
}

async function getBackupPlanLimits() {
  const result = await db.query(
    `SELECT backup_plan_limits
       FROM platform_settings
      WHERE singleton = TRUE
      LIMIT 1`,
  );

  return normalizeBackupPlanLimits(result.rows[0]?.backup_plan_limits);
}

/**
 * Validate and replace plan backup limits in one statement, returning the
 * statement snapshot's previous value and the persisted next value.
 *
 * @param {Object} [input={}] - Plan entitlement settings.
 * @returns {Promise<Object>} Normalized previous and next plan limits.
 */
async function updateBackupPlanLimits(input = {}) {
  const next = parseRequiredBackupPlanLimits(input);
  // The CTE and UPSERT keep each request to one statement. `previous` comes
  // from that statement's snapshot, so concurrent writers may report the same
  // pre-write value even though their updates serialize on the singleton row.
  const result = await db.query(
    `WITH prev AS (
       SELECT backup_plan_limits AS old_limits
         FROM platform_settings
        WHERE singleton = TRUE
     )
     INSERT INTO platform_settings(singleton, backup_plan_limits, updated_at)
     VALUES(TRUE, $1, NOW())
     ON CONFLICT (singleton) DO UPDATE SET
       backup_plan_limits = EXCLUDED.backup_plan_limits,
       updated_at = NOW()
     RETURNING
       backup_plan_limits AS next_limits,
       (SELECT old_limits FROM prev) AS previous_limits`,
    [JSON.stringify(next)],
  );

  const row = result.rows[0] || {};
  return {
    previous: normalizeBackupPlanLimits(row.previous_limits),
    next: normalizeBackupPlanLimits(row.next_limits || next),
  };
}

/**
 * Validate and persist backup storage settings, encrypting supplied credentials
 * while preserving or explicitly clearing existing secrets as requested.
 *
 * @param {Object} [settings={}] - Admin storage, schedule, and credential settings.
 * @returns {Promise<Object>} Admin-safe persisted backup settings.
 */
async function updateBackupSettings(settings = {}) {
  const next = parseRequiredBackupSettings(settings);
  const current = await db.query(
    `SELECT backup_s3_access_key_id_encrypted,
            backup_s3_secret_access_key_encrypted,
            backup_ssh_private_key_encrypted,
            backup_ssh_password_encrypted
       FROM platform_settings
      WHERE singleton = TRUE
      LIMIT 1`,
  );

  let s3AccessKeyIdEncrypted = current.rows[0]?.backup_s3_access_key_id_encrypted || null;
  let s3SecretAccessKeyEncrypted = current.rows[0]?.backup_s3_secret_access_key_encrypted || null;
  let sshPrivateKeyEncrypted = current.rows[0]?.backup_ssh_private_key_encrypted || null;
  let sshPasswordEncrypted = current.rows[0]?.backup_ssh_password_encrypted || null;

  if (next.clearS3AccessKey) {
    s3AccessKeyIdEncrypted = null;
  } else if (next.s3AccessKeyId !== undefined) {
    if (next.s3AccessKeyId) ensureEncryptionConfigured("Backup storage credential storage");
    s3AccessKeyIdEncrypted = next.s3AccessKeyId
      ? encrypt(next.s3AccessKeyId)
      : s3AccessKeyIdEncrypted;
  }

  if (next.clearS3SecretAccessKey) {
    s3SecretAccessKeyEncrypted = null;
  } else if (next.s3SecretAccessKey !== undefined) {
    if (next.s3SecretAccessKey) ensureEncryptionConfigured("Backup storage credential storage");
    s3SecretAccessKeyEncrypted = next.s3SecretAccessKey
      ? encrypt(next.s3SecretAccessKey)
      : s3SecretAccessKeyEncrypted;
  }

  if (next.clearSshPrivateKey) {
    sshPrivateKeyEncrypted = null;
  } else if (next.sshPrivateKey !== undefined) {
    if (next.sshPrivateKey) ensureEncryptionConfigured("Backup storage credential storage");
    sshPrivateKeyEncrypted = next.sshPrivateKey
      ? encrypt(next.sshPrivateKey)
      : sshPrivateKeyEncrypted;
  }

  if (next.clearSshPassword) {
    sshPasswordEncrypted = null;
  } else if (next.sshPassword !== undefined) {
    if (next.sshPassword) ensureEncryptionConfigured("Backup storage credential storage");
    sshPasswordEncrypted = next.sshPassword ? encrypt(next.sshPassword) : sshPasswordEncrypted;
  }

  const result = await db.query(
    `INSERT INTO platform_settings(
       singleton,
       backup_storage_backend,
       backup_local_path,
       backup_s3_bucket,
       backup_s3_region,
       backup_s3_endpoint,
       backup_s3_access_key_id_encrypted,
       backup_s3_secret_access_key_encrypted,
       backup_ssh_host,
       backup_ssh_port,
       backup_ssh_username,
       backup_ssh_remote_path,
       backup_ssh_private_key_encrypted,
       backup_ssh_password_encrypted,
       backup_installation_schedule_enabled,
       backup_installation_schedule_frequency,
       backup_installation_schedule_hour_utc,
       backup_installation_schedule_day_of_week,
       updated_at
     )
     VALUES(TRUE, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, NOW())
     ON CONFLICT (singleton) DO UPDATE SET
       backup_storage_backend = EXCLUDED.backup_storage_backend,
       backup_local_path = EXCLUDED.backup_local_path,
       backup_s3_bucket = EXCLUDED.backup_s3_bucket,
       backup_s3_region = EXCLUDED.backup_s3_region,
       backup_s3_endpoint = EXCLUDED.backup_s3_endpoint,
       backup_s3_access_key_id_encrypted = EXCLUDED.backup_s3_access_key_id_encrypted,
       backup_s3_secret_access_key_encrypted = EXCLUDED.backup_s3_secret_access_key_encrypted,
       backup_ssh_host = EXCLUDED.backup_ssh_host,
       backup_ssh_port = EXCLUDED.backup_ssh_port,
       backup_ssh_username = EXCLUDED.backup_ssh_username,
       backup_ssh_remote_path = EXCLUDED.backup_ssh_remote_path,
       backup_ssh_private_key_encrypted = EXCLUDED.backup_ssh_private_key_encrypted,
       backup_ssh_password_encrypted = EXCLUDED.backup_ssh_password_encrypted,
       backup_installation_schedule_enabled = EXCLUDED.backup_installation_schedule_enabled,
       backup_installation_schedule_frequency = EXCLUDED.backup_installation_schedule_frequency,
       backup_installation_schedule_hour_utc = EXCLUDED.backup_installation_schedule_hour_utc,
       backup_installation_schedule_day_of_week = EXCLUDED.backup_installation_schedule_day_of_week,
       updated_at = NOW()
     RETURNING *`,
    [
      next.storageBackend,
      next.localPath,
      next.s3Bucket,
      next.s3Region,
      next.s3Endpoint,
      s3AccessKeyIdEncrypted,
      s3SecretAccessKeyEncrypted,
      next.sshHost,
      next.sshPort,
      next.sshUsername,
      next.sshRemotePath,
      sshPrivateKeyEncrypted,
      sshPasswordEncrypted,
      next.installationScheduleEnabled,
      next.installationScheduleFrequency,
      next.installationScheduleHourUtc,
      next.installationScheduleDayOfWeek,
    ],
  );

  return resolveBackupSettingsPayload(normalizeBackupSettings(result.rows[0] || next));
}

// General settings persistence

/**
 * Clamp deployment defaults to platform resource ceilings before persisting them.
 *
 * @param {Object} [defaults={}] - Requested vCPU, memory, and disk defaults.
 * @param {Object} [limits={}] - Maximum platform resource values.
 * @returns {Promise<Object>} Persisted clamped defaults.
 */
async function updateDeploymentDefaults(defaults = {}, limits = {}) {
  const clamped = clampDeploymentDefaults(defaults, limits);
  const result = await db.query(
    `INSERT INTO platform_settings(
       singleton,
       default_vcpu,
       default_ram_mb,
       default_disk_gb,
       updated_at
     )
     VALUES(TRUE, $1, $2, $3, NOW())
     ON CONFLICT (singleton) DO UPDATE SET
       default_vcpu = EXCLUDED.default_vcpu,
       default_ram_mb = EXCLUDED.default_ram_mb,
       default_disk_gb = EXCLUDED.default_disk_gb,
       updated_at = NOW()
     RETURNING default_vcpu, default_ram_mb, default_disk_gb`,
    [clamped.vcpu, clamped.ram_mb, clamped.disk_gb],
  );

  return clampDeploymentDefaults(result.rows[0] || clamped, limits);
}

async function updateLanguageSettings(settings = {}) {
  const next = parseRequiredLanguageSettings(settings);
  const result = await db.query(
    `INSERT INTO platform_settings(
       singleton,
       default_locale,
       updated_at
     )
     VALUES(TRUE, $1, NOW())
     ON CONFLICT (singleton) DO UPDATE SET
       default_locale = EXCLUDED.default_locale,
       updated_at = NOW()
     RETURNING default_locale`,
    [next.defaultLocale],
  );

  return resolveLanguageSettingsPayload(result.rows[0] || next);
}

async function updateSystemBanner(banner = {}) {
  const next = parseRequiredSystemBanner(banner);
  const result = await db.query(
    `INSERT INTO platform_settings(
       singleton,
       system_banner_enabled,
       system_banner_severity,
       system_banner_title,
       system_banner_message,
       updated_at
     )
     VALUES(TRUE, $1, $2, $3, $4, NOW())
     ON CONFLICT (singleton) DO UPDATE SET
       system_banner_enabled = EXCLUDED.system_banner_enabled,
       system_banner_severity = EXCLUDED.system_banner_severity,
       system_banner_title = EXCLUDED.system_banner_title,
       system_banner_message = EXCLUDED.system_banner_message,
       updated_at = NOW()
     RETURNING system_banner_enabled,
               system_banner_severity,
               system_banner_title,
               system_banner_message`,
    [next.enabled, next.severity, next.title, next.message],
  );

  return resolveSystemBannerPayload(result.rows[0] || next);
}

/**
 * Validate and persist Agent Hub defaults, encrypting a replacement source key
 * while preserving or explicitly clearing the existing credential.
 *
 * @param {Object} [settings={}] - Sharing defaults, URL, and source-key controls.
 * @returns {Promise<Object>} Admin-safe persisted Agent Hub settings.
 */
async function updateAgentHubSettings(settings = {}) {
  const next = parseRequiredAgentHubSettings(settings);
  const current = await db.query(
    `SELECT agent_hub_api_key_encrypted
       FROM platform_settings
      WHERE singleton = TRUE
      LIMIT 1`,
  );
  let encryptedApiKey = current.rows[0]?.agent_hub_api_key_encrypted || null;
  if (next.clearSourceApiKey) {
    encryptedApiKey = null;
  } else if (next.sourceApiKey !== undefined) {
    if (next.sourceApiKey) {
      ensureEncryptionConfigured("Agent Hub source API key storage");
      encryptedApiKey = encrypt(next.sourceApiKey);
    } else {
      encryptedApiKey = current.rows[0]?.agent_hub_api_key_encrypted || null;
    }
  }

  const result = await db.query(
    `INSERT INTO platform_settings(
       singleton,
       agent_hub_default_share_target,
       agent_hub_url,
       agent_hub_api_key_encrypted,
       updated_at
     )
     VALUES(TRUE, $1, $2, $3, NOW())
     ON CONFLICT (singleton) DO UPDATE SET
       agent_hub_default_share_target = EXCLUDED.agent_hub_default_share_target,
       agent_hub_url = EXCLUDED.agent_hub_url,
       agent_hub_api_key_encrypted = EXCLUDED.agent_hub_api_key_encrypted,
       updated_at = NOW()
     RETURNING agent_hub_default_share_target,
               agent_hub_url,
               agent_hub_api_key_encrypted`,
    [next.defaultShareTarget, next.url, encryptedApiKey],
  );

  return resolveAgentHubSettingsPayload(normalizeAgentHubSettings(result.rows[0] || next));
}

module.exports = {
  DEFAULT_DEPLOYMENT_DEFAULTS,
  DEFAULT_AGENT_HUB_SETTINGS,
  DEFAULT_BACKUP_PLAN_LIMITS,
  DEFAULT_BACKUP_SETTINGS,
  DEFAULT_LANGUAGE_SETTINGS,
  DEFAULT_SMTP_SETTINGS,
  DEFAULT_SYSTEM_BANNER,
  AGENT_HUB_SHARE_TARGETS,
  BACKUP_PLAN_KEYS,
  BACKUP_SCHEDULE_FREQUENCIES,
  BACKUP_STORAGE_BACKENDS,
  SYSTEM_BANNER_SEVERITIES,
  SUPPORTED_LOCALES,
  clampDeploymentDefaults,
  getAgentHubSettings,
  getAgentHubSourceApiKey,
  getBackupPlanLimits,
  getBackupSettings,
  getBackupStorageConfig,
  getDeploymentDefaults,
  getLanguageSettings,
  getSmtpDeliveryConfig,
  getSmtpSettings,
  getSystemBanner,
  isSystemBannerFeatureEnabled,
  normalizeAgentHubSettings,
  normalizeBackupPlanLimits,
  normalizeBackupSettings,
  normalizeDeploymentDefaults,
  normalizeLanguageSettings,
  normalizeLocale,
  normalizeSmtpSettings,
  normalizeSystemBanner,
  parseRequiredAgentHubSettings,
  parseRequiredBackupPlanLimits,
  parseRequiredBackupSettings,
  parseRequiredDeploymentDefaults,
  parseRequiredLanguageSettings,
  parseRequiredLocale,
  parseRequiredSmtpSettings,
  parseRequiredSystemBanner,
  resolveBackupSettingsPayload,
  resolveLanguageSettingsPayload,
  resolveSmtpSettingsPayload,
  resolvePreferredLocale,
  resolveSystemBannerPayload,
  updateAgentHubSettings,
  updateBackupPlanLimits,
  updateBackupSettings,
  updateDeploymentDefaults,
  updateLanguageSettings,
  updateSmtpSettings,
  updateSystemBanner,
};
