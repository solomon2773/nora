#!/usr/bin/env bash
# infra-tests/lib/docker_ctl.sh — container-lifecycle helpers for the
# services under test (backend-api, worker-provisioner) and for standalone
# test containers created by lib/agent.sh.
#
# Named docker_ctl.sh rather than docker.sh to avoid ever shadowing a `docker`
# alias/function if one gets sourced into the same shell.

COMPOSE_ROOT="${COMPOSE_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"

# compose <args...> — run docker compose from the repo root regardless of
# the caller's current directory.
compose() {
  (cd "$COMPOSE_ROOT" && docker compose "$@")
}

# wait_for_healthy <service> <timeout_s> — polls `docker compose ps` until
# the named service reports "healthy" (or just "Up" if it has no
# healthcheck), or the timeout elapses. Returns non-zero on timeout.
wait_for_healthy() {
  local service="$1" timeout_s="${2:-60}" waited=0
  while [ "$waited" -lt "$timeout_s" ]; do
    local status
    status="$(compose ps --format '{{.Health}} {{.State}}' "$service" 2>/dev/null | head -1)"
    if echo "$status" | grep -qE 'healthy|^running$' || echo "$status" | grep -q '^ running'; then
      return 0
    fi
    sleep 1
    waited=$((waited + 1))
  done
  return 1
}

# container_id_for <compose-service> — resolves a compose service name to
# its current container id, for use with `docker kill`/`docker inspect`
# when you need signal-level control compose itself doesn't expose
# (`compose kill` sends SIGKILL to the right target, but some tests want to
# assert on the container's exit code/timing directly).
container_id_for() {
  compose ps -q "$1"
}

# start_log_emitter <name> — starts a minimal, dependency-free container
# that prints an incrementing counter once a second, for use as a
# lightweight "agent" log source (see lib/agent.sh). Plain `sh`/`echo` in
# alpine rather than anything heavier — the only thing under test is
# whether Nora's collector/writer correctly handles whatever this emits,
# not the emitter itself.
start_log_emitter() {
  local name="$1"
  docker run -d --name "$name" --label nora-infra-test=1 alpine:3.20 \
    sh -c 'i=0; while true; do echo "infra-test line $i"; i=$((i+1)); sleep 1; done' >/dev/null
}

# force_flush_via_sigterm <verify_query> [max_attempts]
#
# Restarts worker-provisioner (graceful stop = SIGTERM) to force
# segmentWriter.flushAll() to run, then confirms it actually landed via
# `verify_query` (a SQL query, run through db_query — expected to return a
# nonzero/nonempty value once the flush succeeded, e.g. a segment-count
# COUNT(*) for the agent under test) — retrying rather than assuming a
# clean `compose stop` means the flush itself succeeded.
#
# Why this retry exists: worker.ts's shutdown coordinator raced
# flushAll() against its own internal deadline and exited either way. This
# was a REAL, reproducibly intermittent race, not a hypothetical edge case
# — confirmed directly from worker-provisioner's own logs during this
# suite's development: "[shutdown] flushAll did not complete within
# 10000ms — exiting anyway." Sometimes the flush landed in ~500ms,
# sometimes it lost the race and the buffered segment was never written
# at all, because segmentWriter.ts's own retry-park backoff ladder sums to
# ~15.5s on its own — longer than the original 10s deadline could ever
# accommodate even under ideal conditions. **Fixed**: the deadline is now
# 20000ms (`registerShutdownCoordinator`'s default in worker.ts), giving
# one full retry-ladder cycle real headroom. `compose stop -t <N>` calls
# throughout this suite were bumped from 15s to 25s to match — a shorter
# Compose stop-grace than the app's own internal deadline would just let
# Docker SIGKILL the process before its own shutdown logic ever got to run,
# silently reintroducing the same race from the outside. This helper's
# retry loop is kept as cheap insurance against any remaining timing
# variance, not because the deadline race is still expected to lose often.
#
# Why there's a 35s wait BETWEEN retries, not an immediate re-stop: a lost
# flush doesn't just fail to persist — the process exits either way (per
# the log above), which destroys segmentWriter's entire in-memory buffer
# for every agent. Retrying immediately just races an EMPTY buffer against
# the same deadline (trivially "wins" by having nothing to flush, which
# still fails verify_query) — confirmed by a live repro during this
# suite's development where 3 immediate retries in a row all failed this
# way. The content is NOT lost from the source (the agent container's own
# log history is untouched, and nothing was ever flushed so the collector's
# cursor is still empty) — but the collector needs its own ~30s reconcile
# tick to reattach and re-buffer that content before a SECOND SIGTERM has
# anything real to lose the race over. Hence the wait.
#
# Callers that are testing failure/loss behavior on purpose (e.g.
# phase3/04's MinIO-down scenario, where "nothing flushed" can be a
# meaningful outcome, not just noise) should keep calling `compose stop`/
# `compose up` directly instead of this helper.
force_flush_via_sigterm() {
  local verify_query="$1"
  local max_attempts="${2:-3}"
  local attempt=1
  while [ "$attempt" -le "$max_attempts" ]; do
    compose stop -t 25 worker-provisioner >/dev/null
    compose up -d worker-provisioner >/dev/null
    wait_for_healthy worker-provisioner 60 || log_warn "unhealthy after restart, continuing"
    local result
    result="$(db_query "$verify_query")"
    if [ -n "$result" ] && [ "$result" != "0" ]; then
      return 0
    fi
    if [ "$attempt" -lt "$max_attempts" ]; then
      log_warn "flush attempt ${attempt}/${max_attempts} did not produce the expected result — this is the shutdown coordinator's own documented 10s-deadline race (see this function's header), not necessarily a bug in what's under test. Waiting ~35s for the collector to reattach and re-buffer before retrying."
      sleep 35
    else
      log_warn "flush attempt ${attempt}/${max_attempts} did not produce the expected result."
    fi
    attempt=$((attempt + 1))
  done
  return 1
}

stop_and_remove() {
  local name="$1"
  docker rm -f "$name" >/dev/null 2>&1 || true
}

# cleanup_orphaned_test_containers — safety net: removes any leftover
# nora-infra-test=1 labeled containers from a previous run that crashed
# before its own cleanup ran. Safe to call at the start of any script.
cleanup_orphaned_test_containers() {
  local ids
  ids="$(docker ps -aq --filter "label=nora-infra-test=1")"
  if [ -n "$ids" ]; then
    log_warn "removing $(echo "$ids" | wc -l | tr -d ' ') orphaned test container(s) from a previous run"
    docker rm -f $ids >/dev/null 2>&1 || true
  fi
}
