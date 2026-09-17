#!/usr/bin/env bash
# infra-tests/lib/quarantine.sh — real per-test isolation for migration
# tests, discovered necessary the hard way: `migrateSegmentBatch`
# (storageMigration.ts) migrates every row matching `storage_backend =
# job.from_backend`, installation-wide, by design — there is no per-agent
# scope in the product, because a real destination migration genuinely is
# a platform-wide operation. A phase5b test that inserts a `local -> X`
# job therefore does not only touch its own 1-2 test segments; it also
# migrates every OTHER agent's `local` segments that happen to exist at
# the time, including real ones. This is not hypothetical: running this
# suite against this session's real dev stack migrated two real agents'
# (`agent2`, `agent3`) log segments to the test MinIO bucket, deleting
# their local copies in the process (job was `keep_source: false`).
# Recovered by hand afterward with a real `s3 -> local` migration job —
# but a test should never have needed that recovery in the first place.
#
# The fix: since the product's own migration query filters strictly on
# the `storage_backend` column's literal value, temporarily reassigning
# every OTHER agent's `local` segment to a sentinel value the product
# never matches makes them invisible to the query for the duration of the
# test — true isolation, with no product code change, because it's built
# on the exact same mechanism the real migration already trusts.
#
# This intentionally does NOT use `assert_only_test_local_segments`'s old
# approach (refuse to proceed if foreign local data exists) — that made
# one test's leftover state block every later test from running, which is
# the opposite of what a test suite should do. Quarantining lets every
# phase5b test run regardless of what else exists, while still guaranteeing
# it only ever touches its own data.

QUARANTINE_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$QUARANTINE_LIB_DIR/db.sh"

QUARANTINE_SENTINEL="local__infra_test_quarantined"
QUARANTINED_ACTIVE=""

# restore_any_stuck_quarantined_segments — safety net for a previous run
# that crashed hard enough to skip its own cleanup trap (SIGKILL, not a
# graceful stop/Ctrl-C). Un-quarantines anything still marked with the
# sentinel value, putting it back to 'local' where the product can see it
# again. Call this unconditionally at the start of every phase5b script,
# the same way cleanup_orphaned_test_agents is called for agent rows.
restore_any_stuck_quarantined_segments() {
  local stuck
  stuck="$(db_query "SELECT COUNT(*) FROM log_segments WHERE storage_backend = '${QUARANTINE_SENTINEL}';")"
  if [ "$stuck" -gt 0 ]; then
    log_warn "found ${stuck} segment(s) still quarantined from a previous run that didn't clean up (crashed?) — restoring them to storage_backend='local' now"
    db_exec "UPDATE log_segments SET storage_backend = 'local' WHERE storage_backend = '${QUARANTINE_SENTINEL}';" >/dev/null
  fi
}

# quarantine_foreign_local_segments <agent-id> [<agent-id> ...]
#
# Reassigns storage_backend for every 'local' segment NOT belonging to one
# of the given agent ids to the sentinel value above. Call this AFTER
# provisioning this test's own agent(s) and flushing their segment(s), and
# BEFORE creating any migration job — everything still tagged 'local' at
# job-creation time is then guaranteed to be this test's own.
#
# Sets QUARANTINED_ACTIVE=1 if anything was quarantined, so callers/cleanup
# can tell at a glance. Always call restore_quarantined_local_segments in
# cleanup regardless (it's a no-op if nothing is quarantined).
quarantine_foreign_local_segments() {
  local expected_ids_sql=""
  local id
  for id in "$@"; do
    expected_ids_sql="${expected_ids_sql}${expected_ids_sql:+,}'${id}'"
  done
  local quarantined_count
  quarantined_count="$(db_query "SELECT COUNT(*) FROM log_segments WHERE storage_backend = 'local' AND agent_id NOT IN (${expected_ids_sql});")"
  if [ "$quarantined_count" -gt 0 ]; then
    log_warn "quarantining ${quarantined_count} local segment(s) belonging to OTHER agents (not this test's own) for the duration of this migration test — a migration job can't touch what it can't see. Restored automatically on exit."
    db_exec "UPDATE log_segments SET storage_backend = '${QUARANTINE_SENTINEL}' WHERE storage_backend = 'local' AND agent_id NOT IN (${expected_ids_sql});" >/dev/null
    QUARANTINED_ACTIVE=1
  fi
}

# restore_quarantined_local_segments — reverses quarantine_foreign_local_segments.
# Safe to call even if nothing was quarantined (no-op). MUST be called
# unconditionally in cleanup — put it early, before anything that could
# exit the script, so a mid-test failure still restores real data.
restore_quarantined_local_segments() {
  if [ -n "$QUARANTINED_ACTIVE" ]; then
    db_exec "UPDATE log_segments SET storage_backend = 'local' WHERE storage_backend = '${QUARANTINE_SENTINEL}';" >/dev/null 2>&1 || true
    log_info "restored quarantined segment(s) back to storage_backend='local'"
    QUARANTINED_ACTIVE=""
  fi
}

# ── Backend-generic quarantine ─────────────────────────────────────────────
#
# The functions above only hide `local` segments, which is enough for a
# local -> X migration. A migration INTO local reads from another backend,
# and this stack has foreign `s3` segments too, so those need hiding as well.
# The sentinel is always "<backend>__infra_test_quarantined" — for `local`
# that is exactly QUARANTINE_SENTINEL above, so both families of helpers
# restore each other's rows.

QUARANTINE_SUFFIX="__infra_test_quarantined"

# quarantine_foreign_segments <backend> <agent-id> [<agent-id> ...]
quarantine_foreign_segments() {
  local backend="$1"
  shift
  local ids_sql="" id
  for id in "$@"; do
    ids_sql="${ids_sql}${ids_sql:+,}'${id}'"
  done
  local count
  count="$(db_query "SELECT COUNT(*) FROM log_segments WHERE storage_backend = '${backend}' AND agent_id NOT IN (${ids_sql});")"
  if [ "$count" -gt 0 ]; then
    log_warn "quarantining ${count} '${backend}' segment(s) belonging to OTHER agents for the duration of this test — restored automatically on exit"
    db_exec "UPDATE log_segments SET storage_backend = '${backend}${QUARANTINE_SUFFIX}' WHERE storage_backend = '${backend}' AND agent_id NOT IN (${ids_sql});" >/dev/null
    QUARANTINED_ACTIVE=1
  fi
}

# restore_all_quarantined_segments — reverses quarantine_foreign_segments (and
# quarantine_foreign_local_segments) for every backend. Safe to call always.
restore_all_quarantined_segments() {
  db_exec "UPDATE log_segments SET storage_backend = left(storage_backend, length(storage_backend) - length('${QUARANTINE_SUFFIX}')) WHERE right(storage_backend, length('${QUARANTINE_SUFFIX}')) = '${QUARANTINE_SUFFIX}';" >/dev/null 2>&1 || true
  QUARANTINED_ACTIVE=""
}

# restore_any_stuck_quarantined_segments_all_backends — start-of-script safety
# net for a crashed earlier run, covering every backend's sentinel.
restore_any_stuck_quarantined_segments_all_backends() {
  local stuck
  stuck="$(db_query "SELECT COUNT(*) FROM log_segments WHERE right(storage_backend, length('${QUARANTINE_SUFFIX}')) = '${QUARANTINE_SUFFIX}';")"
  if [ "$stuck" -gt 0 ]; then
    log_warn "found ${stuck} segment(s) still quarantined from a previous run — restoring them now"
    restore_all_quarantined_segments
  fi
}
