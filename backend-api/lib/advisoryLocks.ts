// @ts-nocheck
// Shared guards for PostgreSQL advisory locks.
//
// Nora serialises provisioning and provider mutations with session-level
// advisory locks. That is the right primitive — a session lock is released
// automatically when its connection drops, so a crashed worker cannot wedge the
// queue. What it does not survive is a *live* process whose guarded operation
// never returns: the session sits idle while still holding the lock, and every
// other caller waits forever behind it (#406).
//
// Two guards, for the two sides of that failure:
//
//   advisoryLockClientOptions — waiters. A bare `pg_advisory_lock` blocks with no
//   bound, so a stuck holder turned `POST /api/llm-providers` into a request
//   that hung past the reverse proxy's 60s limit and 504'd, sometimes after the
//   INSERT had already committed, so a client retry produced duplicate rows.
//   Postgres applies lock_timeout to advisory locks, so a bounded wait fails
//   fast and predictably instead.
//
//   startAdvisoryLockHoldWatchdog — holders. If the guarded work never
//   completes, the unlock in `finally` never runs. The watchdog ends the
//   connection, which is exactly the path a crash would take, so Postgres
//   releases the lock and the queue drains.
//
// The watchdog deliberately trades one risk for another: dropping the lock
// while the abandoned operation may still be running re-opens the concurrency
// the lock existed to prevent. That is the better trade — the alternative,
// observed on a fresh install three times in an hour, is a permanently wedged
// deploy queue and an onboarding flow that 504s. Its budget is therefore set
// well above any legitimate hold so it only fires on genuinely stuck work.

const DEFAULT_LOCK_WAIT_MS = 30000;
const MIN_LOCK_WAIT_MS = 10;
const MAX_LOCK_WAIT_MS = 120000;

// SQLSTATE raised when lock_timeout expires ("canceling statement due to lock
// timeout"). Distinct from 57014 (statement_timeout / query cancel).
const LOCK_TIMEOUT_SQLSTATE = "55P03";

/**
 * Clamp a configured advisory-lock wait into a sane range.
 *
 * @param {*} value - Raw configured value, usually from the environment.
 * @param {number} [fallbackMs] - Value used when the input is not a number.
 * @returns {number} Milliseconds within the supported range.
 */
function normalizeAdvisoryLockWaitMs(value, fallbackMs = DEFAULT_LOCK_WAIT_MS) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed)
    ? Math.max(MIN_LOCK_WAIT_MS, Math.min(parsed, MAX_LOCK_WAIT_MS))
    : fallbackMs;
}

/**
 * Build the pg connection `options` that bound lock waits on a lock session.
 *
 * Applied at connect time rather than as a follow-up statement: it needs no
 * extra round trip, cannot be skipped by an early return between connecting and
 * acquiring, and keeps the query sequence on these sessions unchanged.
 *
 * The bound covers every lock wait on the session, not only the advisory
 * acquire. That is intended — these are dedicated, short-lived lock clients, and
 * a row lock that never returns wedges the caller just as thoroughly as an
 * advisory one.
 *
 * @param {*} waitMs - Desired wait, normalized before use.
 * @param {string} [existingOptions] - Options already configured, preserved.
 * @returns {string} Value for the pg client's `options` field.
 */
function advisoryLockClientOptions(waitMs, existingOptions = "") {
  const normalized = normalizeAdvisoryLockWaitMs(waitMs);
  return [String(existingOptions || "").trim(), `-c lock_timeout=${normalized}`]
    .filter(Boolean)
    .join(" ");
}

/**
 * Report whether an error is Postgres refusing to keep waiting for a lock.
 *
 * @param {*} error - Error thrown by a lock acquire.
 * @returns {boolean} True when lock_timeout expired.
 */
function isAdvisoryLockTimeout(error) {
  return error?.code === LOCK_TIMEOUT_SQLSTATE;
}

/**
 * Build the error surfaced when a lock could not be taken in time.
 *
 * 409 rather than 503: the request is refused because another operation holds
 * the resource, and retrying the same call later is the correct response.
 *
 * @param {string} message - Operator-facing description.
 * @param {Object} [options={}] - Error code and HTTP status overrides.
 * @returns {Error} Error carrying `code` and `statusCode`.
 */
function advisoryLockBusyError(message, { code = "ADVISORY_LOCK_BUSY", statusCode = 409 } = {}) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

/**
 * Force an abandoned lock session to release by ending its connection.
 *
 * Returns a canceller that must be called once the guarded work settles.
 *
 * @param {Object} client - The lock-holding pg client.
 * @param {Object} [options={}] - Budget and reporting hook.
 * @returns {Function} Cancels the watchdog.
 */
function startAdvisoryLockHoldWatchdog(client, { maxHoldMs, onTimeout } = {}) {
  const budget = Number.parseInt(maxHoldMs, 10);
  if (!Number.isFinite(budget) || budget <= 0) return () => {};

  const timer = setTimeout(() => {
    try {
      onTimeout?.(budget);
    } catch {
      // A reporting hook must never mask the release itself.
    }
    // Ending the connection is what actually frees the lock: Postgres drops
    // session-level advisory locks when the session goes away.
    Promise.resolve(client?.end?.()).catch(() => {});
  }, budget);
  // Never keep the process alive purely to wait on this.
  timer.unref?.();

  return () => clearTimeout(timer);
}

module.exports = {
  DEFAULT_LOCK_WAIT_MS,
  LOCK_TIMEOUT_SQLSTATE,
  advisoryLockBusyError,
  advisoryLockClientOptions,
  isAdvisoryLockTimeout,
  normalizeAdvisoryLockWaitMs,
  startAdvisoryLockHoldWatchdog,
};
