#!/usr/bin/env bash
# Phase 3, test 3: an agent restarting mid-window yields ONE segment
# spanning the restart, not two, and loses nothing — duplicating some
# already-buffered content is expected, not a bug.
#
# The buffer is keyed (agent_id, stream), so a reattach after the agent's
# own container restarts should find and append to the existing buffer
# rather than opening a new one. Getting this wrong doesn't lose data, but
# it fragments a crash-looping agent into one segment per restart — up to
# 30x the index rows and search fan-out for exactly the agent an operator
# is most likely to be actively reading. This needs a real container
# restart (real PID change, real Docker restart event) to actually
# exercise the reattach path — a mock can't misrepresent "is this the same
# buffer" the way a real timing race between restart and reconcile can.
#
# What this does NOT assert, on purpose: that the resulting content has no
# duplicate lines. `logCollector.ts`'s own module header documents this as
# a deliberate tradeoff, not an oversight — `since` only ever advances at a
# FLUSH boundary (`lastFlushedCursor`, `MAX(ts_to)` over already-flushed
# `log_segments`), never per line seen. Since nothing has been flushed yet
# at the point of this test's reattach, the reattach necessarily replays
# the container's entire retained history again — including whatever was
# already sitting in the open, unflushed buffer — duplicating it. The
# alternative (track an in-memory "last line seen" cursor and resume from
# there instead) would let a REAL crash lose whatever was in that
# in-memory cursor along with the buffer itself, reintroducing exactly the
# data-loss failure mode this design exists to avoid. This is the standard
# at-least-once tradeoff used by most durability-focused log/event
# pipelines (Kafka consumers committing offsets after processing, Filebeat/
# Fluentd advancing a read-offset only after a confirmed flush, etc.):
# duplicates on reconnect are acceptable; silent loss is not. So this test
# checks for a FLOOR (nothing missing) and a CEILING (duplication stays
# bounded to what the documented mechanism predicts, not unbounded/
# runaway) — see the final assertion block for the exact math.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/common.sh"
source "$SCRIPT_DIR/../lib/db.sh"
source "$SCRIPT_DIR/../lib/docker_ctl.sh"
source "$SCRIPT_DIR/../lib/agent.sh"
source "$SCRIPT_DIR/../lib/node_call.sh"

require_confirmation
test_start "segment-writer" "02-reattach-across-agent-restart"
cleanup_orphaned_test_containers
cleanup_orphaned_test_agents
warn_if_destination_not_local

AGENT_ID=""
CONTAINER_NAME=""

# Precondition: the whole attach -> restart -> reattach -> SIGTERM window
# (~35s + 8s + ~10s docker restart, since the emitter's `sh` ignores
# SIGTERM + 35s + 8s ≈ 96s, plus force_flush retries) must fit inside ONE
# flush-timer interval. Otherwise the writer's own timer legitimately seals
# a segment mid-test, and the "exactly 1 segment" assertion fails for a
# reason that has nothing to do with reattach. NORA_LOG_FLUSH_INTERVAL_MS is
# a dev override (default 15 min); a short value like 60000 makes this test
# meaningless, so refuse to run rather than report a false reattach bug.
MIN_FLUSH_INTERVAL_MS=180000
flush_interval_ms="$(compose exec -T worker-provisioner printenv NORA_LOG_FLUSH_INTERVAL_MS 2>/dev/null | tr -d '[:space:]')"
if [ -n "$flush_interval_ms" ] && [ "$flush_interval_ms" -lt "$MIN_FLUSH_INTERVAL_MS" ]; then
  test_fail "precondition not met: worker-provisioner has NORA_LOG_FLUSH_INTERVAL_MS=${flush_interval_ms}, shorter than this test's ~96s+ observation window (need >= ${MIN_FLUSH_INTERVAL_MS}). The flush timer would seal a segment mid-test and produce 2+ segments regardless of reattach correctness. Unset it (or raise it) in .env, recreate worker-provisioner, and re-run."
  exit 0
fi

cleanup() {
  test_trap_incomplete
  if [ -n "$CONTAINER_NAME" ]; then
    teardown_test_agent "$AGENT_ID" "$CONTAINER_NAME"
  fi
  compose up -d worker-provisioner >/dev/null 2>&1 || true
}
trap cleanup EXIT

log_step "provisioning a dedicated test agent"
_AGENT_INFO="$(provision_test_agent "reattach")"
AGENT_ID="$(echo "$_AGENT_INFO" | sed -n '1p')"
CONTAINER_NAME="$(echo "$_AGENT_INFO" | sed -n '2p')"
log_info "agent_id=$AGENT_ID container=$CONTAINER_NAME"

log_step "waiting ~35s for the collector's 30s reconcile tick to attach"
sleep 35

log_step "letting it emit for 8s before the restart"
sleep 8
lines_before_restart="$(docker logs "$CONTAINER_NAME" 2>&1 | wc -l | tr -d ' ')"
log_info "container emitted $lines_before_restart line(s) before the restart"

log_step "restarting the AGENT's container (not the worker) mid-window"
docker restart "$CONTAINER_NAME" >/dev/null
restart_epoch="$(date -u +%s)"
log_info "agent container restarted at epoch $restart_epoch"

log_step "waiting ~35s for the collector to notice the dead stream and reattach"
sleep 35

log_step "letting it emit for 8s more post-restart"
sleep 8
# `docker restart` does not clear a container's own stdout history (the
# json-file log driver appends across a restart, only a removal clears
# it), so this total includes both the pre- and post-restart lines. The
# emitter's own internal counter DOES reset to 0 on restart, so post-restart
# content duplicates "infra-test line 0, 1, 2..." — fine here, this test
# only needs total counts and timestamp bracketing, not the
# unique-line-number check phase4's reconnect test uses.
lines_total_after_restart="$(docker logs "$CONTAINER_NAME" 2>&1 | wc -l | tr -d ' ')"
log_info "container emitted $lines_total_after_restart line(s) total (pre + post restart)"

log_step "forcing a flush via graceful SIGTERM (retries on the shutdown coordinator's own documented 10s-deadline race — see force_flush_via_sigterm's header — since a missed flush here would test nothing about reattach)"
force_flush_via_sigterm "SELECT COUNT(*) FROM log_segments WHERE agent_id = '${AGENT_ID}';" \
  || log_warn "flush never landed after retries — segment_count check below will catch this as a failure"

log_step "checking log_segments for this agent"
segment_count="$(db_query "SELECT COUNT(*) FROM log_segments WHERE agent_id = '${AGENT_ID}';")"
log_info "segment_count=$segment_count"

if [ "$segment_count" -eq 0 ]; then
  test_fail "no segment was flushed at all — cannot evaluate the reattach guarantee"
  exit 0
elif [ "$segment_count" -ne 1 ]; then
  test_fail "found $segment_count segments for one restart — expected exactly 1. The agent restart likely caused the collector to open a NEW buffer instead of reattaching to the existing one (buffer keying or reconcile-tick timing bug)"
  exit 0
fi

# segment_count == 1 alone is NOT sufficient to call this a pass: if the
# pre-restart buffer content were silently dropped (a real bug — e.g. the
# collector opening a fresh buffer post-restart while discarding whatever
# was in the old one) and only the post-restart half got flushed, this
# would ALSO show exactly one segment. The actual claim under test is
# "one segment spanning the restart with nothing lost," which requires
# checking content, not just row count.
# Compared as epoch seconds, not raw text — Postgres's timestamptz text
# output ("2026-09-10 22:15:30.123+00") and `date`'s ISO form
# ("2026-09-10T22:15:30Z") use different separators, so a lexicographic
# string comparison between them breaks at the very first differing
# character (space vs. "T") and would silently always evaluate as "less
# than" regardless of the actual times — caught this while reviewing the
# script, not by running it, which is exactly why it needed a second look.
ts_from_epoch="$(db_query "SELECT EXTRACT(EPOCH FROM ts_from)::bigint FROM log_segments WHERE agent_id = '${AGENT_ID}' LIMIT 1;")"
ts_to_epoch="$(db_query "SELECT EXTRACT(EPOCH FROM ts_to)::bigint FROM log_segments WHERE agent_id = '${AGENT_ID}' LIMIT 1;")"
segment_lines="$(db_query "SELECT lines FROM log_segments WHERE agent_id = '${AGENT_ID}' LIMIT 1;")"
log_info "segment ts_from_epoch=$ts_from_epoch ts_to_epoch=$ts_to_epoch lines=$segment_lines (restart was at epoch $restart_epoch)"

spans_restart=1
if [ "$ts_from_epoch" -gt "$restart_epoch" ]; then
  spans_restart=0
fi
if [ "$ts_to_epoch" -lt "$restart_epoch" ]; then
  spans_restart=0
fi

# Floor: nothing may be missing. Below `lines_total_after_restart` (every
# line the container ever visibly emitted, pre- and post-restart) means
# real, un-mitigated loss — not the documented tradeoff.
#
# Ceiling: NOT a wall-clock arithmetic prediction (an earlier version of
# this check compared segment_lines against lines_before_restart +
# lines_total_after_restart + a flat tolerance -- confirmed by direct
# content inspection to be unreliable: `docker logs | wc -l` is a snapshot
# taken slightly BEFORE the actual `docker restart` call fires, so on a
# loaded host the emitter can produce several more lines in that gap than
# the snapshot counted, pushing the real replay set past a tolerance that
# was sized for clock slop alone -- a test-measurement artifact, not
# evidence of runaway duplication in the collector).
#
# Instead, this checks the actual flushed content directly: since nothing
# was flushed before the reattach, `since` was still unset, so the
# reattach replays the container's ENTIRE retained history again — every
# pre-restart line should appear AT MOST TWICE (once from the original
# capture, once from the reattach's full replay), and post-restart lines
# (which the replay only ever sees once, going forward) should appear
# exactly once. A physical log line's identity is its (message, ts) pair
# — `ts` here is the stable per-line timestamp Docker itself stamps a log
# line with (confirmed empirically: two copies of the same replayed line
# carry the identical timestamp down to the nanosecond, so re-reading the
# same underlying docker log entry can never manufacture a new identity).
# The emitter's own counter resets to 0 on restart, so "line 0" before and
# after the restart are genuinely different physical entries that happen
# to share a message string — grouping by message ALONE would conflate
# them into a false "triplicate," which is exactly the false positive a
# flat count-only check would produce; (message, ts) tells them apart.
# Anything appearing MORE than twice under this identity means the
# collector replayed the same physical line more than once — a real
# regression, not the accepted tradeoff.
storage_key="$(db_query "SELECT storage_key FROM log_segments WHERE agent_id = '${AGENT_ID}' LIMIT 1;")"
max_multiplicity=0
runaway_lines="[]"
if [ -n "$storage_key" ]; then
  duplication_report="$(node_call "
    const fs = require('fs');
    const zlib = require('zlib');
    const { decryptSegment } = require('./logs/segmentWriter.ts');
    const buf = fs.readFileSync('/var/lib/nora-logs/${storage_key}');
    const decrypted = decryptSegment(buf);
    const decompressed = zlib.zstdDecompressSync(decrypted);
    const lines = decompressed.toString('utf8').split('\n').filter(Boolean);
    const counts = new Map();
    for (const raw of lines) {
      const parsed = JSON.parse(raw);
      const key = (parsed.message || '') + '@' + parsed.ts;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    const max = Math.max(0, ...counts.values());
    const runaway = [...counts.entries()].filter(([, c]) => c > 2);
    console.log(JSON.stringify({ max, runaway }));
    process.exit(0);
  ")"
  if [ -n "$duplication_report" ]; then
    max_multiplicity="$(echo "$duplication_report" | node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(0,"utf8")).max))' 2>/dev/null || echo 0)"
    runaway_lines="$(echo "$duplication_report" | node -e 'process.stdout.write(JSON.stringify(JSON.parse(require("fs").readFileSync(0,"utf8")).runaway))' 2>/dev/null || echo "[]")"
  fi
fi
log_info "duplication check: max_multiplicity_per_physical_line=$max_multiplicity (expect <= 2), runaway_lines=$runaway_lines (expect [])"

if [ "$spans_restart" -eq 0 ]; then
  test_fail "the single segment's timestamps (epoch $ts_from_epoch - $ts_to_epoch) do NOT bracket the restart (epoch $restart_epoch) — segment_count was 1, but this looks like only the pre- OR post-restart half was actually captured, not a genuine span across the restart"
elif [ "$segment_lines" -lt "$lines_total_after_restart" ]; then
  test_fail "segment recorded only $segment_lines line(s), fewer than the $lines_total_after_restart line(s) the container ever visibly emitted — real data loss, not the documented at-least-once duplication tradeoff"
elif [ "$max_multiplicity" -gt 2 ]; then
  test_fail "at least one physical log line (identified by message+timestamp) was replayed $max_multiplicity times, more than the documented one-time-replay ceiling of 2 — duplication is NOT bounded the way the design promises (see this script's header): $runaway_lines"
else
  test_pass "one segment (epoch $ts_from_epoch - $ts_to_epoch, lines=$segment_lines) genuinely spans the restart at epoch $restart_epoch, with nothing missing (floor: $lines_total_after_restart) and duplication bounded to the documented one-time replay (max_multiplicity_per_physical_line=$max_multiplicity, never above 2) — reattach found the existing buffer, and any duplicate lines here are the accepted at-least-once tradeoff (see this script's header), not a bug"
fi
