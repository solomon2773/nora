// @ts-nocheck
// Transactional, append-only schema migration runner. Migration versions are
// positional by design: existing entries must never be reordered or edited;
// add new statements at the end so deployed installations receive only the
// missing work.

const crypto = require("crypto");

const MIGRATION_LOCK_KEY = "7484724135246120";
const DEFAULT_MIGRATION_LOCK_TIMEOUT_MS = 60_000;
const DEFAULT_MIGRATION_STATEMENT_TIMEOUT_MS = 600_000;

function migrationChecksum(sql) {
  return crypto.createHash("sha256").update(String(sql)).digest("hex");
}

function normalizeMigrations(migrations = []) {
  return migrations.map((entry, index) => {
    const sql = typeof entry === "string" ? entry : entry?.sql;
    if (!sql || typeof sql !== "string") {
      throw new Error(`Migration ${index + 1} must contain SQL text`);
    }
    return {
      version: index + 1,
      name:
        typeof entry === "object" && entry?.name
          ? String(entry.name).slice(0, 160)
          : `legacy-reconciliation-${String(index + 1).padStart(4, "0")}`,
      sql,
      checksum: migrationChecksum(sql),
    };
  });
}

function normalizeCompatibilityRepairs(repairs = []) {
  return repairs.map((entry, index) => {
    const sql = typeof entry === "string" ? entry : entry?.sql;
    if (!sql || typeof sql !== "string") {
      throw new Error(`Compatibility repair ${index + 1} must contain SQL text`);
    }
    return {
      name:
        typeof entry === "object" && entry?.name
          ? String(entry.name).slice(0, 160)
          : `legacy-compatibility-${String(index + 1).padStart(4, "0")}`,
      sql,
    };
  });
}

function boundedTimeoutMs(value, fallback, { min = 1_000, max = 3_600_000 } = {}) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

async function runVersionedMigrations(pool, migrations, options = {}) {
  if (!pool || typeof pool.query !== "function") {
    throw new Error("A PostgreSQL pool or client is required");
  }

  const normalized = normalizeMigrations(migrations);
  const compatibilityRepairs = normalizeCompatibilityRepairs(options.compatibilityRepairs || []);
  const env = options.env || process.env;
  const lockTimeoutMs = boundedTimeoutMs(
    options.lockTimeoutMs ?? env.DB_MIGRATION_LOCK_TIMEOUT_MS,
    DEFAULT_MIGRATION_LOCK_TIMEOUT_MS,
    { min: 1_000, max: 600_000 },
  );
  const statementTimeoutMs = boundedTimeoutMs(
    options.statementTimeoutMs ?? env.DB_MIGRATION_STATEMENT_TIMEOUT_MS,
    DEFAULT_MIGRATION_STATEMENT_TIMEOUT_MS,
  );
  const client = typeof pool.connect === "function" ? await pool.connect() : pool;
  const release = typeof client.release === "function" ? () => client.release() : () => {};
  const logger = options.logger || console;
  let transactionStarted = false;

  try {
    await client.query("BEGIN");
    transactionStarted = true;
    await client.query("SELECT set_config('lock_timeout', $1, true)", [`${lockTimeoutMs}ms`]);
    try {
      await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [MIGRATION_LOCK_KEY]);
    } catch (error) {
      if (error?.code === "55P03") {
        const timeoutError = new Error(
          `Timed out acquiring the database migration lock after ${lockTimeoutMs}ms`,
        );
        timeoutError.code = error.code;
        timeoutError.cause = error;
        throw timeoutError;
      }
      throw error;
    }
    await client.query("SELECT set_config('lock_timeout', '0', true)");
    await client.query("SELECT set_config('statement_timeout', $1, true)", [
      `${statementTimeoutMs}ms`,
    ]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);

    for (const repair of compatibilityRepairs) {
      try {
        await client.query(repair.sql);
      } catch (error) {
        error.message = `Compatibility repair (${repair.name}) failed: ${error.message}`;
        throw error;
      }
    }

    const appliedResult = await client.query(
      "SELECT version, name, checksum FROM schema_migrations ORDER BY version ASC",
    );
    const applied = new Map((appliedResult.rows || []).map((row) => [Number(row.version), row]));
    let appliedCount = 0;

    for (const migration of normalized) {
      const prior = applied.get(migration.version);
      if (prior) {
        if (prior.checksum !== migration.checksum) {
          throw new Error(
            `Migration ${migration.version} (${migration.name}) was modified after being applied`,
          );
        }
        continue;
      }

      try {
        await client.query(migration.sql);
      } catch (error) {
        error.message = `Migration ${migration.version} (${migration.name}) failed: ${error.message}`;
        throw error;
      }
      await client.query(
        "INSERT INTO schema_migrations(version, name, checksum) VALUES($1, $2, $3)",
        [migration.version, migration.name, migration.checksum],
      );
      appliedCount += 1;
    }

    await client.query("COMMIT");
    transactionStarted = false;
    logger.info?.(
      `DB migrations verified (${normalized.length} total, ${appliedCount} newly applied)`,
    );
    return { total: normalized.length, applied: appliedCount };
  } catch (error) {
    if (transactionStarted) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        logger.error?.(`DB migration rollback failed: ${rollbackError.message}`);
      }
    }
    throw error;
  } finally {
    release();
  }
}

module.exports = {
  DEFAULT_MIGRATION_LOCK_TIMEOUT_MS,
  DEFAULT_MIGRATION_STATEMENT_TIMEOUT_MS,
  MIGRATION_LOCK_KEY,
  boundedTimeoutMs,
  migrationChecksum,
  normalizeCompatibilityRepairs,
  normalizeMigrations,
  runVersionedMigrations,
};
