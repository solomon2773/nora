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
const DEFAULT_TTL_MS = 10_000;

function getDb() {
  return require("../../../backend-api/db.ts");
}

/** true / false when NORA_LOG_ENABLED says so, undefined when it is unset or unrecognised. */
function parseEnvDecision(env = process.env) {
  const raw = String(env.NORA_LOG_ENABLED ?? "").trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(raw)) return true;
  if (["false", "0", "no", "off"].includes(raw)) return false;
  return undefined;
}

/**
 * The stored decision: true, false, or null when an admin has not chosen (or
 * the column does not exist yet on a database that has not been migrated).
 */
async function readStoredDecision(deps = {}) {
  try {
    const db = deps.db || getDb();
    const result = await db.query(
      `SELECT log_collection_enabled
         FROM platform_settings
        WHERE singleton = TRUE
        LIMIT 1`,
    );
    const value = result.rows?.[0]?.log_collection_enabled;
    return typeof value === "boolean" ? value : null;
  } catch (error) {
    if (error && (error.code === UNDEFINED_COLUMN || error.code === UNDEFINED_TABLE)) return null;
    throw error;
  }
}

function stateFrom(stored, env = process.env) {
  if (typeof stored === "boolean") {
    return { enabled: stored, decided: true, source: "database" };
  }
  const fromEnv = parseEnvDecision(env);
  if (typeof fromEnv === "boolean") {
    return { enabled: fromEnv, decided: true, source: "env" };
  }
  return { enabled: false, decided: false, source: "default" };
}

/** Uncached: reads the database every call. */
async function resolveLogCollectionState(deps = {}) {
  const stored = await readStoredDecision(deps);
  return stateFrom(stored, deps.env || process.env);
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
        logger.warn(`[logCollectionState] could not read the setting, keeping the last known value: ${error.message}`);
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

  function invalidate() {
    cached = null;
    cachedAt = 0;
  }

  return { state, isEnabled, invalidate };
}

let defaultGate = null;
function getLogCollectionGate() {
  if (!defaultGate) defaultGate = createLogCollectionGate();
  return defaultGate;
}

module.exports = {
  parseEnvDecision,
  readStoredDecision,
  stateFrom,
  resolveLogCollectionState,
  createLogCollectionGate,
  getLogCollectionGate,
  DEFAULT_TTL_MS,
};
