// @ts-nocheck
// Whether agent logs are collected right now, and who decided.
//
// Collection stores agent output on disk, so it is opt-in. Three states:
//
//   - database  platform_settings.log_collection_enabled is set (an admin chose
//               in the dashboard). Authoritative from then on, like the log
//               storage destination.
//   - env       NORA_LOG_ENABLED is true/false in .env (setup wrote it, or an
//               operator did). Used until an admin changes it in the dashboard.
//   - default   neither is set. Nobody has decided: collection is OFF and the
//               dashboard asks. This is what an unattended upgrade leaves behind.
//
// worker-provisioner and backend-api are separate processes, so a change made
// through the backend reaches the worker by polling this module (short TTL),
// not by a cache invalidation call.
//
// Lives under workers/provisioner/ because the backend loads these modules too
// (see CLAUDE.md, "Backend adapter code sharing").

const UNDEFINED_COLUMN = "42703";
const UNDEFINED_TABLE = "42P01";
const DEFAULT_TTL_MS = 5_000;

function getDb() {
  return require("../../../backend-api/db.ts");
}

/** true / false when NORA_LOG_ENABLED says so, undefined when it is unset or unrecognised. */
function parseEnvDecision(env = process.env) {
  const raw = String(env.NORA_LOG_ENABLED ?? "")
    .trim()
    .toLowerCase();
  if (["true", "1", "yes", "on"].includes(raw)) return true;
  if (["false", "0", "no", "off"].includes(raw)) return false;
  return undefined;
}

/**
 * The stored decision and when it last changed: `{ value, updatedAt }`, where
 * `value` is true, false, or null when an admin has not chosen (or the column
 * does not exist yet on a database that has not been migrated).
 */
async function readStoredState(deps = {}) {
  try {
    const db = deps.db || getDb();
    const result = await db.query(
      `SELECT log_collection_enabled, log_collection_updated_at
         FROM platform_settings
        WHERE singleton = TRUE
        LIMIT 1`,
    );
    const row = result.rows?.[0];
    const value =
      typeof row?.log_collection_enabled === "boolean" ? row.log_collection_enabled : null;
    const raw = row?.log_collection_updated_at;
    const updatedAt = raw ? new Date(raw).toISOString() : null;
    return { value, updatedAt };
  } catch (error) {
    if (error && (error.code === UNDEFINED_COLUMN || error.code === UNDEFINED_TABLE)) {
      return { value: null, updatedAt: null };
    }
    throw error;
  }
}

/** Just the stored decision: true, false, or null. */
async function readStoredDecision(deps = {}) {
  return (await readStoredState(deps)).value;
}

/**
 * @param {boolean|null} stored - the stored decision.
 * @param {Object} env
 * @param {string|null} [updatedAt] - when the stored decision last changed. Only
 *   an ENABLED, stored decision carries a `since`: output produced before it must
 *   not be collected, or turning collection on would back-fill what was written
 *   while it was off (and re-importing a deleted history).
 */
function stateFrom(stored, env = process.env, updatedAt = null) {
  if (typeof stored === "boolean") {
    return { enabled: stored, decided: true, source: "database", since: stored ? updatedAt : null };
  }
  const fromEnv = parseEnvDecision(env);
  if (typeof fromEnv === "boolean") {
    return { enabled: fromEnv, decided: true, source: "env", since: null };
  }
  return { enabled: false, decided: false, source: "default", since: null };
}

/**
 * Records an admin's decision. The timestamp moves only when the value
 * actually changes, so repeating "turn on" while on does not shift `since`.
 */
async function setLogCollectionEnabled(enabled, deps = {}) {
  const db = deps.db || getDb();
  await db.query(
    `INSERT INTO platform_settings(singleton, log_collection_enabled, log_collection_updated_at, updated_at)
     VALUES (TRUE, $1, NOW(), NOW())
     ON CONFLICT (singleton) DO UPDATE SET
       log_collection_updated_at = CASE
         WHEN platform_settings.log_collection_enabled IS DISTINCT FROM EXCLUDED.log_collection_enabled
           THEN NOW()
         ELSE platform_settings.log_collection_updated_at
       END,
       log_collection_enabled = EXCLUDED.log_collection_enabled,
       updated_at = NOW()`,
    [enabled],
  );
}

/** Uncached: reads the database every call. */
async function resolveLogCollectionState(deps = {}) {
  const { value, updatedAt } = await readStoredState(deps);
  return stateFrom(value, deps.env || process.env, updatedAt);
}

/**
 * A cached view of the state for callers that ask often (the collectors'
 * 30-second reconcile ticks). If the database cannot be read, keeps the last
 * known answer rather than flapping collection on and off, and falls back to
 * the env-derived state when there is no last answer.
 */
function createLogCollectionGate(deps = {}) {
  const resolve = deps.resolve || resolveLogCollectionState;
  const ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS;
  const now = deps.now || Date.now;
  const logger = deps.logger || console;
  const env = deps.env || process.env;

  let cached = null;
  let cachedAt = 0;
  let inflight = null;

  async function state() {
    if (cached && now() - cachedAt < ttlMs) return cached;
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        cached = await resolve();
      } catch (error) {
        logger.warn(
          `[logCollectionState] could not read the setting, keeping the last known value: ${error.message}`,
        );
        if (!cached) cached = stateFrom(null, env);
      } finally {
        cachedAt = now();
        inflight = null;
      }
      return cached;
    })();
    return inflight;
  }

  async function isEnabled() {
    return (await state()).enabled;
  }

  /** ISO time before which output must not be collected, or null for no bound. */
  async function since() {
    return (await state()).since || null;
  }

  function invalidate() {
    cached = null;
    cachedAt = 0;
  }

  return { state, isEnabled, since, invalidate };
}

let defaultGate = null;
function getLogCollectionGate() {
  if (!defaultGate) defaultGate = createLogCollectionGate();
  return defaultGate;
}

module.exports = {
  parseEnvDecision,
  readStoredState,
  readStoredDecision,
  setLogCollectionEnabled,
  stateFrom,
  resolveLogCollectionState,
  createLogCollectionGate,
  getLogCollectionGate,
  DEFAULT_TTL_MS,
};
