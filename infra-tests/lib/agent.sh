#!/usr/bin/env bash
# infra-tests/lib/agent.sh — provision/teardown a dedicated, throwaway test
# agent so infra tests never touch real dev agents or their log history.
#
# The "agent" is a plain alpine container emitting a line/second (see
# lib/docker_ctl.sh's start_log_emitter) plus a matching row in `agents`
# pointed at it — the minimum needed for the real code paths under test
# (logCollector's reconciler query, containerManager.logs()) to treat it as
# a genuine running agent. It is deliberately NOT a real OpenClaw/Hermes
# runtime: provisioning one of those through the full deploy pipeline would
# make every test slow and dependent on LLM-provider config that has
# nothing to do with what's being tested here. What matters for Phase
# 3-7's guarantees is the log-streaming/storage path, which this exercises
# identically to a real agent — `containerManager.logs()` just runs
# `docker logs -f <container_id>` under the hood regardless of what's
# inside the container.

AGENT_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$AGENT_LIB_DIR/db.sh"
source "$AGENT_LIB_DIR/docker_ctl.sh"

# provision_test_agent <name-suffix>
#
# Prints two lines to stdout: the new agent's UUID, then the container
# name. Capture with sed, NOT `read -r A B < <(...)` and NOT `mapfile`:
# `read` with multiple var names splits ONE line by whitespace rather than
# consuming a second line into the second variable (silently leaves the
# second var empty), and `mapfile`/`readarray` don't exist on bash 3.2 —
# what macOS ships by default, since Apple stopped updating bash at the
# GPLv2/v3 license boundary. These scripts target bash 3.2 throughout for
# that reason — no mapfile, no associative arrays, no `${var,,}`.
#   _INFO="$(provision_test_agent "worker-kill")"
#   AGENT_ID="$(echo "$_INFO" | sed -n '1p')"
#   CONTAINER_NAME="$(echo "$_INFO" | sed -n '2p')"
provision_test_agent() {
  local suffix="$1"
  local container_name="nora-infra-test-${suffix}-$(date +%s)"
  local owner_user_id
  owner_user_id="$(db_query "SELECT id FROM users ORDER BY created_at LIMIT 1;")"
  if [ -z "$owner_user_id" ]; then
    echo "provision_test_agent: no user row exists to own the test agent — create one first" >&2
    return 1
  fi

  start_log_emitter "$container_name"
  local container_id
  container_id="$(docker inspect -f '{{.Id}}' "$container_name")"

  local agent_id
  agent_id="$(db_query "
    INSERT INTO agents (user_id, name, status, container_id, container_name, backend_type, deploy_target, runtime_family)
    VALUES ('${owner_user_id}', 'infra-test-${suffix}', 'running', '${container_id}', '${container_name}', 'docker', 'docker', 'openclaw')
    RETURNING id;
  ")"

  if [ -z "$agent_id" ]; then
    echo "provision_test_agent: INSERT did not return an id — check the agents table schema hasn't changed" >&2
    stop_and_remove "$container_name"
    return 1
  fi

  echo "$agent_id"
  echo "$container_name"
}

# teardown_test_agent <agent-id> <container-name>
#
# Removes the container and the agent row, plus anything the test caused
# to be written under that agent (log_segments, any storage objects they
# point at, legacy copies) — a test that leaves debris behind makes the
# NEXT run's assertions unreliable (e.g. a capacity test whose leftover
# segments inflate the next run's baseline usage).
teardown_test_agent() {
  local agent_id="$1" container_name="$2"

  stop_and_remove "$container_name"

  # Best-effort object cleanup before the DB rows disappear — after the
  # DELETE below we'd have no storage_key/storage_config left to resolve
  # credentials from. A failure here is logged, not fatal: an orphaned
  # object is exactly what Phase 5's daily reconciliation exists to catch.
  local keys
  keys="$(db_query "SELECT storage_key FROM log_segments WHERE agent_id = '${agent_id}';")"
  if [ -n "$keys" ]; then
    log_warn "test agent ${agent_id} left storage object(s) behind — not deleting from the object store automatically (reconciliation will catch true orphans); deleting index rows only"
  fi

  db_exec "DELETE FROM log_segment_legacy_copies WHERE log_segment_id IN (SELECT id FROM log_segments WHERE agent_id = '${agent_id}');" >/dev/null
  db_exec "DELETE FROM log_segments WHERE agent_id = '${agent_id}';" >/dev/null
  db_exec "DELETE FROM agent_log_cursors WHERE agent_id = '${agent_id}';" >/dev/null 2>&1 || true
  db_exec "DELETE FROM agents WHERE id = '${agent_id}';" >/dev/null
}

# cleanup_orphaned_test_agents — DB-row counterpart to
# docker_ctl.sh's cleanup_orphaned_test_containers: removes any
# `infra-test-*` agent rows (and their segments) left behind by a
# previous run that crashed hard enough to skip its own cleanup trap
# (a SIGKILL rather than a graceful stop/Ctrl-C). Keeps stale debris from
# a crashed prior run out of the installation-wide counts phase5b's
# scripts compute (segments_total etc.) — not required for correctness
# there (those scripts already handle arbitrary pre-existing local data),
# but keeps the numbers meaningful run to run. Call this alongside
# `cleanup_orphaned_test_containers` at the start of any script that
# provisions agents.
cleanup_orphaned_test_agents() {
  local stale_ids
  stale_ids="$(db_query "SELECT id FROM agents WHERE name LIKE 'infra-test-%';")"
  if [ -z "$stale_ids" ]; then
    return 0
  fi
  log_warn "removing orphaned test agent row(s) from a previous run: $(echo "$stale_ids" | wc -l | tr -d ' ')"
  local id
  while IFS= read -r id; do
    [ -n "$id" ] || continue
    db_exec "DELETE FROM log_segment_legacy_copies WHERE log_segment_id IN (SELECT id FROM log_segments WHERE agent_id = '${id}');" >/dev/null 2>&1 || true
    db_exec "DELETE FROM log_segments WHERE agent_id = '${id}';" >/dev/null 2>&1 || true
    db_exec "DELETE FROM agent_log_cursors WHERE agent_id = '${id}';" >/dev/null 2>&1 || true
    db_exec "DELETE FROM agents WHERE id = '${id}';" >/dev/null 2>&1 || true
  done <<< "$stale_ids"
}
