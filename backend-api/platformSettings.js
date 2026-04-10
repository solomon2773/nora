const db = require("./db");

const DEFAULT_DEPLOYMENT_DEFAULTS = Object.freeze({
  vcpu: 1,
  ram_mb: 1024,
  disk_gb: 10,
});

function parseInteger(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function clampInteger(value, min, max = Number.MAX_SAFE_INTEGER) {
  return Math.min(max, Math.max(min, value));
}

function normalizeDeploymentDefaults(
  input = {},
  fallback = DEFAULT_DEPLOYMENT_DEFAULTS
) {
  return {
    vcpu: parseInteger(input.vcpu ?? input.default_vcpu) ?? fallback.vcpu,
    ram_mb:
      parseInteger(input.ram_mb ?? input.default_ram_mb) ?? fallback.ram_mb,
    disk_gb:
      parseInteger(input.disk_gb ?? input.default_disk_gb) ?? fallback.disk_gb,
  };
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

async function getDeploymentDefaults() {
  const result = await db.query(
    `SELECT default_vcpu, default_ram_mb, default_disk_gb
       FROM platform_settings
      WHERE singleton = TRUE
      LIMIT 1`
  );
  return clampDeploymentDefaults(result.rows[0] || DEFAULT_DEPLOYMENT_DEFAULTS);
}

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
    [clamped.vcpu, clamped.ram_mb, clamped.disk_gb]
  );

  return clampDeploymentDefaults(result.rows[0] || clamped, limits);
}

module.exports = {
  DEFAULT_DEPLOYMENT_DEFAULTS,
  clampDeploymentDefaults,
  getDeploymentDefaults,
  normalizeDeploymentDefaults,
  parseRequiredDeploymentDefaults,
  updateDeploymentDefaults,
};
