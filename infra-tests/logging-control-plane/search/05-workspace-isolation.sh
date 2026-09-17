#!/usr/bin/env bash
# Phase 6, matrix row 5: the plan's workspace-isolation assertions, run
# against real rows, real credentials, and the real HTTP route.
#
# The plan bolds these as "the core isolation assertion." This README row
# originally suggested they belong in backend-api/__tests__/ instead, since
# no infra condition changes the outcome — and logSearch.test.ts does cover
# the logic. It covers it against a fake db and a hand-built actor, though,
# and the access model has two bypasses a fake can model wrong without any
# test noticing:
#
#   - A platform admin's findAccessibleAgentForActor returns ANY agent, with
#     no workspace lookup at all.
#   - An owner's findAccessibleAgent returns their agent on the user_id fast
#     path, also with no workspace lookup.
#
# For both, logSearch.enforceWorkspaceScope is the only barrier left. So this
# builds the real thing — two workspaces, a third unassigned agent, a second
# real user who is a viewer of one workspace and owns nothing, and a real API
# key from the real createApiKey — and sends every request through nginx.
#
# Every rejection is paired with a positive control. A 403 or 404 proves
# nothing on its own if the legitimate path is also broken, or if the target
# agent simply has no data to leak. So each agent is first shown returning
# real lines to an actor who should see them.
#
# Rejections are asserted on their `code` field, not just their status. The
# scope guard in front of this route answers a key missing `logs:read` with a
# 403 as well, and a test checking the status alone would read that
# misconfiguration as isolation working.
#
# Every case runs and is reported, rather than stopping at the first
# failure: for a security matrix, knowing which actors leak matters more
# than knowing that one does.
#
# Product decision (overrides the plan's Decision 14): in the Logging page a
# platform admin sees every agent across every workspace. An admin SESSION
# that names no workspace is therefore allowed for any agent, including
# unassigned ones. Two limits still hold and are asserted: an admin who names
# the WRONG workspace is rejected (a malformed request, not an access
# decision), and an API key issued by an admin stays confined to its bound
# workspace, since a key request carries its issuer's admin role.
#
# Non-admins see agents they own plus agents in workspaces they belong to;
# another user's unassigned agent stays invisible. GET /logs/agents, which
# feeds the Logging agent picker, is checked against the same rules.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/common.sh"
source "$SCRIPT_DIR/../lib/db.sh"
source "$SCRIPT_DIR/../lib/docker_ctl.sh"
source "$SCRIPT_DIR/../lib/agent.sh"
source "$SCRIPT_DIR/../lib/auth.sh"
source "$SCRIPT_DIR/../lib/node_call_backend_api.sh"

require_confirmation
test_start "search" "05-workspace-isolation"
cleanup_orphaned_test_containers
cleanup_orphaned_test_agents
warn_if_destination_not_local

STAMP="$(date +%s)"
AGENT_A=""; CONTAINER_A=""
AGENT_B=""; CONTAINER_B=""
AGENT_C=""; CONTAINER_C=""
WS_A=""; WS_B=""
MEMBER_ID=""
REQ_DIR=""
FAILURES=""
PASSES=0
CHECKS=0

cleanup() {
  test_trap_incomplete
  [ -n "$REQ_DIR" ] && rm -rf "$REQ_DIR"
  # Deleting a workspace cascades its workspace_members, workspace_agents,
  # and api_keys rows.
  [ -n "$WS_A" ] && db_exec "DELETE FROM workspaces WHERE id = '${WS_A}';" >/dev/null 2>&1
  [ -n "$WS_B" ] && db_exec "DELETE FROM workspaces WHERE id = '${WS_B}';" >/dev/null 2>&1
  [ -n "$MEMBER_ID" ] && db_exec "DELETE FROM users WHERE id = '${MEMBER_ID}';" >/dev/null 2>&1
  [ -n "$CONTAINER_A" ] && teardown_test_agent "$AGENT_A" "$CONTAINER_A"
  [ -n "$CONTAINER_B" ] && teardown_test_agent "$AGENT_B" "$CONTAINER_B"
  [ -n "$CONTAINER_C" ] && teardown_test_agent "$AGENT_C" "$CONTAINER_C"
  return 0
}
trap cleanup EXIT

iso_offset() {
  date -u -v"$1" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date -u -d "$2" +"%Y-%m-%dT%H:%M:%SZ"
}

# A prior run that crashed hard enough to skip its trap leaves these behind.
db_exec "DELETE FROM workspaces WHERE name LIKE 'infra-test-iso-%';" >/dev/null 2>&1 || true
db_exec "DELETE FROM users WHERE email LIKE 'infra-test-iso-%@nora.invalid';" >/dev/null 2>&1 || true

# ── Fixtures ────────────────────────────────────────────────────────────────

OWNER_ROW="$(db_query "SELECT id, email FROM users ORDER BY created_at LIMIT 1;")"
OWNER_ID="$(echo "$OWNER_ROW" | cut -d'|' -f1)"
OWNER_EMAIL="$(echo "$OWNER_ROW" | cut -d'|' -f2)"
if [ -z "$OWNER_ID" ]; then
  test_fail "no user row exists to own the test agents"
  exit 0
fi
log_info "test agents are owned by ${OWNER_EMAIL} (${OWNER_ID}), as provision_test_agent assigns them"

log_step "provisioning three test agents: one per workspace, and one in no workspace"
_INFO="$(provision_test_agent "iso-a")"; AGENT_A="$(echo "$_INFO" | sed -n '1p')"; CONTAINER_A="$(echo "$_INFO" | sed -n '2p')"
_INFO="$(provision_test_agent "iso-b")"; AGENT_B="$(echo "$_INFO" | sed -n '1p')"; CONTAINER_B="$(echo "$_INFO" | sed -n '2p')"
_INFO="$(provision_test_agent "iso-c")"; AGENT_C="$(echo "$_INFO" | sed -n '1p')"; CONTAINER_C="$(echo "$_INFO" | sed -n '2p')"
log_info "agentA=${AGENT_A} agentB=${AGENT_B} agentC(unassigned)=${AGENT_C}"

log_step "creating workspace A and workspace B, and assigning one agent to each"
WS_A="$(db_query "INSERT INTO workspaces (user_id, name) VALUES ('${OWNER_ID}', 'infra-test-iso-A-${STAMP}') RETURNING id;")"
WS_B="$(db_query "INSERT INTO workspaces (user_id, name) VALUES ('${OWNER_ID}', 'infra-test-iso-B-${STAMP}') RETURNING id;")"
db_exec "INSERT INTO workspace_agents (workspace_id, agent_id) VALUES ('${WS_A}', '${AGENT_A}');" >/dev/null
db_exec "INSERT INTO workspace_agents (workspace_id, agent_id) VALUES ('${WS_B}', '${AGENT_B}');" >/dev/null
if [ -z "$WS_A" ] || [ -z "$WS_B" ]; then
  test_fail "could not create the two test workspaces"
  exit 0
fi
# Real workspace creation makes the creator an owner member, and this matters
# beyond realism: verifyApiKey only accepts a key whose issuer is STILL a
# member of the key's workspace, so a key minted by a non-member is rejected
# with a 401 before any scoping runs. The first run of this script omitted
# this row and every API-key request 401'd, positive control included.
db_exec "INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ('${WS_A}', '${OWNER_ID}', 'owner'), ('${WS_B}', '${OWNER_ID}', 'owner');" >/dev/null
log_info "workspaceA=${WS_A} workspaceB=${WS_B}"

log_step "creating a second, real user who owns nothing and is a viewer of workspace A only"
MEMBER_EMAIL="infra-test-iso-member-${STAMP}@nora.invalid"
MEMBER_ID="$(db_query "INSERT INTO users (email, role, name) VALUES ('${MEMBER_EMAIL}', 'user', 'infra-test isolation member') RETURNING id;")"
if [ -z "$MEMBER_ID" ]; then
  test_fail "could not create the member test user"
  exit 0
fi
db_exec "INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ('${WS_A}', '${MEMBER_ID}', 'viewer');" >/dev/null
log_info "member=${MEMBER_EMAIL} (${MEMBER_ID})"

log_step "minting a real workspace-A API key through the real createApiKey"
# Issued by the owner, who is a platform admin on a stock dev install. That is
# the harder case: an API key request carries its issuer's identity, so an
# admin-issued key would reach every agent through the admin bypass if the
# key's own workspace binding were not enforced first.
KEY_OUTPUT="$(node_call_backend_api "
(async () => {
  const { createApiKey } = require('/app/apiKeys.ts');
  const created = await createApiKey('${WS_A}', '${OWNER_ID}', {
    label: 'infra-test isolation',
    scopes: ['logs:read'],
  });
  console.log('API_KEY=' + created.apiKey);
  process.exit(0);
})().catch((e) => { console.error('SCRIPT_ERR ' + ((e && e.stack) || e)); process.exit(1); });
" 2>&1)"
API_KEY="$(extract_marker API_KEY "$KEY_OUTPUT")"
if [ -z "$API_KEY" ]; then
  test_fail "could not mint a workspace API key: $(printf '%s' "$KEY_OUTPUT" | tail -5 | tr '\n' ' ')"
  exit 0
fi
log_info "workspace-A API key minted with scope logs:read"

log_step "minting session tokens for each actor"
MEMBER_TOKEN="$(mint_jwt_for_user "$MEMBER_ID" "$MEMBER_EMAIL" user)"
# The owner's real row, but claiming role "user": that routes around the admin
# branch and exercises the ownership fast path specifically.
OWNER_TOKEN="$(mint_jwt_for_user "$OWNER_ID" "$OWNER_EMAIL" user)"
ADMIN_TOKEN="$(mint_jwt platform_admin)"
if [ -z "$MEMBER_TOKEN" ] || [ -z "$OWNER_TOKEN" ] || [ -z "$ADMIN_TOKEN" ]; then
  test_fail "could not mint one or more actor tokens (member=${MEMBER_TOKEN:+ok} owner=${OWNER_TOKEN:+ok} admin=${ADMIN_TOKEN:+ok})"
  exit 0
fi

log_step "waiting ~35s for the collector to attach to all three agents, then 8s of emission, so each has real data to leak"
sleep 35
sleep 8

# ── Request helpers ────────────────────────────────────────────────────────

FROM="$(iso_offset -10M '10 minutes ago')"
TO="$(iso_offset +5M '5 minutes')"
REQ_DIR="$(mktemp -d -t nora-infra-iso)"
REQ_N=0

# search_as <credential> <query> — prints "<http_code>|<body_file>"
search_as() {
  REQ_N=$((REQ_N + 1))
  local out="${REQ_DIR}/resp-${REQ_N}.json"
  local code
  code="$(curl -sS -o "$out" -w '%{http_code}' \
    -H "Authorization: Bearer $1" \
    "http://localhost:${NGINX_HTTP_PORT:-8080}/api/logs/search?from=${FROM}&to=${TO}&limit=50&$2")"
  echo "${code}|${out}"
}

# resp_field <body_file> <code|lines>
resp_field() {
  node -e '
    const fs = require("fs");
    let b = {};
    try {
      b = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    } catch (e) {}
    if (process.argv[2] === "lines") {
      process.stdout.write(String(Array.isArray(b.lines) ? b.lines.length : 0));
    } else {
      const v = b[process.argv[2]];
      process.stdout.write(v === null || v === undefined ? "" : String(v));
    }
  ' "$1" "$2"
}

# check <label> <credential> <query> <want_status> <want_code|""> <zero|nonzero>
check() {
  local label="$1" cred="$2" query="$3" want_status="$4" want_code="$5" want_lines="$6"
  local r code file got_code got_lines ok=1
  CHECKS=$((CHECKS + 1))
  r="$(search_as "$cred" "$query")"
  code="${r%%|*}"
  file="${r#*|}"
  got_code="$(resp_field "$file" code)"
  got_lines="$(resp_field "$file" lines)"

  [ "$code" = "$want_status" ] || ok=0
  if [ -n "$want_code" ] && [ "$got_code" != "$want_code" ]; then ok=0; fi
  case "$want_lines" in
    zero) [ "$got_lines" = "0" ] || ok=0 ;;
    nonzero) [ "$got_lines" != "0" ] || ok=0 ;;
  esac

  local got="HTTP ${code} code=${got_code:-none} lines=${got_lines}"
  if [ "$ok" -eq 1 ]; then
    PASSES=$((PASSES + 1))
    log_info "PASS  ${label} -> ${got}"
  else
    local want="HTTP ${want_status}${want_code:+ code=${want_code}} lines=${want_lines}"
    log_warn "FAIL  ${label} -> expected ${want}, got ${got}"
    FAILURES="${FAILURES}${FAILURES:+; }${label} (expected ${want}, got ${got})"
  fi
}

# ── Positive controls ──────────────────────────────────────────────────────
# Without these, every rejection below could simply mean nothing works.

log_step "positive controls — each agent returns real lines to an actor entitled to them"
check "member reads agentA in workspace A" \
  "$MEMBER_TOKEN" "agentId=${AGENT_A}&workspaceId=${WS_A}" 200 "" nonzero
check "admin reads agentB in workspace B (agentB has data to leak)" \
  "$ADMIN_TOKEN" "agentId=${AGENT_B}&workspaceId=${WS_B}" 200 "" nonzero
check "owner reads unassigned agentC" \
  "$OWNER_TOKEN" "agentId=${AGENT_C}" 200 "" nonzero
check "workspace-A API key reads agentA" \
  "$API_KEY" "agentId=${AGENT_A}" 200 "" nonzero

# ── Plan: a workspace-A actor receives zero workspace-B rows ─────────────────

log_step "a workspace-A member receives zero workspace-B rows"
check "member reads agentB scoped to workspace A" \
  "$MEMBER_TOKEN" "agentId=${AGENT_B}&workspaceId=${WS_A}" 404 "" zero
check "member reads agentB naming workspace B" \
  "$MEMBER_TOKEN" "agentId=${AGENT_B}&workspaceId=${WS_B}" 404 "" zero
check "member reads agentB with no workspace" \
  "$MEMBER_TOKEN" "agentId=${AGENT_B}" 404 "" zero
check "member reads agentA without naming its workspace" \
  "$MEMBER_TOKEN" "agentId=${AGENT_A}" 403 wrong_workspace zero

# ── Plan: an admin querying workspace A receives zero workspace-B rows ──────

log_step "a platform admin sees agents in every workspace, but a wrong workspace filter is still rejected"
check "admin reads agentB with no workspace named" \
  "$ADMIN_TOKEN" "agentId=${AGENT_B}" 200 "" nonzero
check "admin reads agentB naming the wrong workspace (A)" \
  "$ADMIN_TOKEN" "agentId=${AGENT_B}&workspaceId=${WS_A}" 403 wrong_workspace zero

# ── Not in the plan's list, but guarded by the same single barrier ─────────

log_step "an owner querying workspace A receives zero workspace-B rows, despite the ownership fast path"
check "owner reads its own agentB scoped to workspace A" \
  "$OWNER_TOKEN" "agentId=${AGENT_B}&workspaceId=${WS_A}" 403 wrong_workspace zero

# ── Plan: an unassigned agent is returned to its owner and nobody else ───────

log_step "an agent with no workspace is returned to its owner and to nobody else"
check "member reads unassigned agentC" \
  "$MEMBER_TOKEN" "agentId=${AGENT_C}" 404 "" zero
check "owner reads unassigned agentC naming workspace A" \
  "$OWNER_TOKEN" "agentId=${AGENT_C}&workspaceId=${WS_A}" 403 wrong_workspace zero

check "admin reads unassigned agentC" \
  "$ADMIN_TOKEN" "agentId=${AGENT_C}" 200 "" nonzero

# ── Plan: an API key scoped to workspace A is rejected for workspace B ──────

log_step "a workspace-A API key is rejected for workspace B"
check "workspace-A key reads agentB" \
  "$API_KEY" "agentId=${AGENT_B}" 403 wrong_workspace zero
check "workspace-A key reads agentB while naming workspace B" \
  "$API_KEY" "agentId=${AGENT_B}&workspaceId=${WS_B}" 403 wrong_workspace zero

# ── The Logging agent picker (GET /logs/agents) ────────────────────────────

# list_check <label> <credential> <must-include ids, comma-separated> <must-exclude ids, comma-separated>
list_check() {
  local label="$1" cred="$2" include="$3" exclude="$4"
  CHECKS=$((CHECKS + 1))
  REQ_N=$((REQ_N + 1))
  local out="${REQ_DIR}/list-${REQ_N}.json"
  local code verdict
  code="$(curl -sS -o "$out" -w '%{http_code}' -H "Authorization: Bearer ${cred}" \
    "http://localhost:${NGINX_HTTP_PORT:-8080}/api/logs/agents")"
  verdict="$(node -e '
    const fs = require("fs");
    let b = [];
    try { b = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); } catch (e) {}
    const ids = new Set((Array.isArray(b) ? b : []).map((a) => a.id));
    const want = process.argv[2].split(",").filter(Boolean);
    const deny = process.argv[3].split(",").filter(Boolean);
    const missing = want.filter((id) => !ids.has(id));
    const leaked = deny.filter((id) => ids.has(id));
    const secrets = (Array.isArray(b) ? b : []).some((a) => "gateway_token" in a);
    process.stdout.write(missing.length + "|" + leaked.length + "|" + secrets);
  ' "$out" "$include" "$exclude")"
  local missing="${verdict%%|*}" rest="${verdict#*|}"
  local leaked="${rest%%|*}" secrets="${rest#*|}"
  local got="HTTP ${code} missing=${missing} leaked=${leaked} secrets=${secrets}"
  if [ "$code" = "200" ] && [ "$missing" = "0" ] && [ "$leaked" = "0" ] && [ "$secrets" = "false" ]; then
    PASSES=$((PASSES + 1))
    log_info "PASS  ${label} -> ${got}"
  else
    log_warn "FAIL  ${label} -> expected HTTP 200 missing=0 leaked=0 secrets=false, got ${got}"
    FAILURES="${FAILURES}${FAILURES:+; }${label} (got ${got})"
  fi
}

log_step "the Logging agent picker offers each actor exactly what they may read"
list_check "admin's picker lists agents in both workspaces and the unassigned one" \
  "$ADMIN_TOKEN" "${AGENT_A},${AGENT_B},${AGENT_C}" ""
list_check "member's picker lists workspace A's agent only" \
  "$MEMBER_TOKEN" "${AGENT_A}" "${AGENT_B},${AGENT_C}"
list_check "workspace-A key's picker lists workspace A's agent only, despite an admin issuer" \
  "$API_KEY" "${AGENT_A}" "${AGENT_B},${AGENT_C}"

# ── Verdict ─────────────────────────────────────────────────────────────────

if [ -z "$FAILURES" ]; then
  test_pass "all ${CHECKS} access checks held against real rows and real credentials: admins read agents in every workspace (and unassigned ones) with no workspace named, while a wrong workspace filter, a non-member, an owner outside the requested workspace, and a workspace-bound API key issued by an admin were all refused zero rows with the expected status and code; the Logging agent picker offered each actor exactly those agents and no secrets"
else
  test_fail "$((CHECKS - PASSES)) of ${CHECKS} access checks failed: ${FAILURES}"
fi
