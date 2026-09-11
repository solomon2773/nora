#!/usr/bin/env bash
# infra-tests/lib/db.sh — thin wrappers around `docker compose exec postgres psql`.
#
# Every query goes through the running `postgres` container rather than a
# host-side psql client, so these scripts work identically on any machine
# that already has the dev stack up — no local psql install required.

COMPOSE_ROOT="${COMPOSE_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"

# db_query <sql> / db_exec <sql> — tuples-only, unaligned, QUIET output.
#
# `-t` (tuples-only) suppresses column headers and row-count footers for a
# SELECT, but NOT the command-completion tag psql prints for INSERT/UPDATE/
# DELETE ("INSERT 0 1", "UPDATE 3", ...) — that tag is only suppressed by
# `-q` (quiet). Without `-q`, `db_query "INSERT ... RETURNING id"` returns
# TWO lines — the tag, then the id — silently corrupting any caller that
# expects exactly one value back. Always pass both flags together.
db_query() {
  (cd "$COMPOSE_ROOT" && docker compose exec -T postgres psql -qtAc "$1" -U nora -d nora)
}

db_exec() {
  (cd "$COMPOSE_ROOT" && docker compose exec -T postgres psql -qtAc "$1" -U nora -d nora)
}

# db_query_until_nonzero <sql> [max_attempts] [sleep_s]
#
# Polls `db_query "$sql"` until it returns a nonzero/nonempty value or
# attempts run out, then returns whatever the LAST read was either way
# (the caller decides what to do with a still-zero result — this never
# masks a genuine zero, it only tolerates a transient one).
#
# Why this exists: found during phase5b-storage-migration test
# development that a COUNT(*) immediately after a confirmed-successful
# flush (worker-provisioner's own log said "[shutdown] flush complete,
# exiting" — not the 10s-deadline race force_flush_via_sigterm guards
# against) can still transiently read 0 moments later, self-resolving
# within a couple seconds. Root cause not fully pinned down despite
# investigation (ruled out: quarantine wrongly catching the agent's own
# row, a leftover migration job, the 10s shutdown race) — but the
# transience itself is real and reproducible, so this polls past it at
# the one place a test needs an accurate count RIGHT NOW rather than
# eventually.
db_query_until_nonzero() {
  local sql="$1"
  local max_attempts="${2:-5}"
  local sleep_s="${3:-2}"
  local attempt=1
  local result
  while [ "$attempt" -le "$max_attempts" ]; do
    result="$(db_query "$sql")"
    if [ -n "$result" ] && [ "$result" != "0" ]; then
      echo "$result"
      return 0
    fi
    [ "$attempt" -lt "$max_attempts" ] && sleep "$sleep_s"
    attempt=$((attempt + 1))
  done
  echo "$result"
  return 1
}

# warn_if_destination_not_local — several scripts implicitly assume the
# platform storage destination is 'local' (they never switch it
# themselves). If a PRIOR script that does switch it — anything in
# phase5b-storage-migration/ or phase3's 04-retry-and-park.sh — was
# interrupted before its own cleanup trap restored the original
# destination (a hard kill rather than a graceful stop/Ctrl-C, which the
# trap can't catch), the next "assumes local" script would fail for a
# confusing, unrelated reason — or, for phase5's daily-reconciliation
# test specifically, would silently check the wrong storage backend
# entirely rather than failing loudly. This doesn't block the script (the
# user may genuinely be testing against a non-local destination on
# purpose) — it just surfaces the mismatch instead of leaving it silent.
warn_if_destination_not_local() {
  local backend
  backend="$(db_query "SELECT COALESCE(log_storage_backend, 'local') FROM platform_settings WHERE singleton = TRUE;")"
  if [ -n "$backend" ] && [ "$backend" != "local" ]; then
    log_warn "current platform storage destination is '${backend}', not 'local' — this script assumes 'local'. If you didn't set this deliberately, a previous test may have been interrupted before restoring it; check for a stale destination row before trusting this run's result."
  fi
}

# db_query_pretty <sql> — aligned, human-readable output for println-style
# debugging inside a test script (not for parsing).
db_query_pretty() {
  (cd "$COMPOSE_ROOT" && docker compose exec -T postgres psql -U nora -d nora -c "$1")
}
