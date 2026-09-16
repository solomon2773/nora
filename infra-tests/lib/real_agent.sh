#!/usr/bin/env bash
# infra-tests/lib/real_agent.sh — resolve a real, dedicated OpenClaw agent by
# NAME for the phase9/10/12 scripts that exercise actual gateway RPC/
# protocol behavior (chat.send, logs.tail, config merge) — not the
# throwaway alpine agents lib/agent.sh provisions, which only exercise the
# container-log path and have no real OpenClaw gateway to talk to.
#
# These agents are NOT provisioned by this suite — no LLM-provider
# bootstrap or gateway-token setup lives here, and creating one takes real
# deploy time. Deploy one yourself (dashboard, CLI, or
# `POST /agents/deploy {"name":"agent2"}`) before running a script that
# needs it.
#
# Why by name, not by id/container name: an agent's `id` and generated
# container name are permanent once created, but the agent itself is not —
# redeploying it (or anyone else's dev stack having a different one)
# produces a different id and container name under the same name. A script
# that hardcodes a resolved id/container name breaks the moment that
# specific agent is gone, for anyone, including the person who wrote it a
# day later. Resolving by name at every run self-heals across a redeploy
# and works on a stack that has never heard of this specific agent, as
# long as an agent with that name exists.

REAL_AGENT_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$REAL_AGENT_LIB_DIR/db.sh"

# resolve_real_agent <default-name> <env-var-name>
#
# Prints "id|container_name" on success. On any failure (no agent with
# that name, or not `status='running'`), calls test_fail with an actionable
# message and exits the calling script — callers do not need their own
# pre-flight status check afterward.
resolve_real_agent() {
  local default_name="$1"
  local env_var_name="$2"
  local agent_name="${!env_var_name:-$default_name}"

  local row
  row="$(db_query "SELECT id, container_name, status FROM agents WHERE name = '${agent_name}';")"
  if [ -z "$row" ]; then
    test_fail "no agent named '${agent_name}' found — deploy a real OpenClaw agent with this name first (dashboard, CLI, or POST /agents/deploy {\"name\":\"${agent_name}\"}), or set ${env_var_name} to the name of an existing one"
    exit 0
  fi

  local id container_name status
  id="$(echo "$row" | cut -d'|' -f1)"
  container_name="$(echo "$row" | cut -d'|' -f2)"
  status="$(echo "$row" | cut -d'|' -f3)"

  if [ "$status" != "running" ]; then
    test_fail "agent '${agent_name}' (${id}) is not running (status=${status}) — start it, or point ${env_var_name} at one that is running"
    exit 0
  fi

  echo "${id}|${container_name}"
}
