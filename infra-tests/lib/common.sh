#!/usr/bin/env bash
# infra-tests/lib/common.sh — shared helpers for every infra-tests script.
#
# Source this from a test script with:
#   SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
#   source "$SCRIPT_DIR/../lib/common.sh"
#
# Every test script is expected to:
#   1. Call `require_confirmation` before doing anything destructive.
#   2. Call `test_start "<phase>" "<test-id>"` once, near the top.
#   3. Call `test_pass "<details>"` or `test_fail "<details>"` exactly once,
#      at the end (or from a trap on error — see phase4's 01 script for the
#      pattern when a mid-script failure should still emit a result).
#   4. Register cleanup with `trap cleanup EXIT` where `cleanup` is a
#      function the test script defines itself — cleanup must run whether
#      the test passed, failed, or the script errored out early.

set -uo pipefail

# ── Colors (disabled automatically when not a TTY, e.g. piped into a log) ──
if [ -t 1 ]; then
  C_RED=$'\033[31m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_BLUE=$'\033[34m'; C_BOLD=$'\033[1m'; C_RESET=$'\033[0m'
else
  C_RED=""; C_GREEN=""; C_YELLOW=""; C_BLUE=""; C_BOLD=""; C_RESET=""
fi

log_info() { echo "${C_BLUE}[info]${C_RESET} $*"; }
log_warn() { echo "${C_YELLOW}[warn]${C_RESET} $*"; }
log_step() { echo "${C_BOLD}[step]${C_RESET} $*"; }

# ── Safety guardrail ────────────────────────────────────────────────────
#
# These tests kill containers, disconnect networks, and mutate database
# state. Requiring an explicit, unambiguous opt-in (an env var, not a CLI
# flag alone) makes it much harder to fire this against the wrong
# environment by habit — e.g. muscle-memory-running a script from the
# wrong terminal tab.
require_confirmation() {
  if [ "${INFRA_TESTS_CONFIRM:-}" != "yes-i-know" ]; then
    echo "${C_RED}Refusing to run: this test is destructive (kills containers," >&2
    echo "disconnects networks, and/or mutates database state).${C_RESET}" >&2
    echo "" >&2
    echo "Set INFRA_TESTS_CONFIRM=yes-i-know to proceed, e.g.:" >&2
    echo "  INFRA_TESTS_CONFIRM=yes-i-know $0" >&2
    exit 2
  fi
}

# ── Timing ───────────────────────────────────────────────────────────────
_TEST_START_MS=0
now_ms() { echo $(($(date +%s%N) / 1000000)); }

# ── Result recording (JSON Lines) ───────────────────────────────────────
#
# One JSON object per line, appended to RESULTS_FILE. run-all.sh sets
# RESULTS_FILE for the whole batch; a script run standalone falls back to
# its own timestamped file under infra-tests/results/ so results are never
# silently lost either way.
INFRA_TESTS_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [ -z "${RESULTS_FILE:-}" ]; then
  mkdir -p "$INFRA_TESTS_ROOT/results"
  RESULTS_FILE="$INFRA_TESTS_ROOT/results/run-$(date -u +%Y%m%dT%H%M%SZ)-standalone.jsonl"
fi
export RESULTS_FILE

_CURRENT_PHASE=""
_CURRENT_TEST=""
_RESULT_EMITTED=0

# json_escape <string> — minimal escaping (backslash, double-quote,
# newline) sufficient for the free-text `details` field. Not a general
# JSON encoder; nothing here needs one.
json_escape() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\n'/\\n}"
  printf '%s' "$s"
}

test_start() {
  _CURRENT_PHASE="$1"
  _CURRENT_TEST="$2"
  _RESULT_EMITTED=0
  _TEST_START_MS=$(now_ms)
  echo ""
  echo "${C_BOLD}━━━ ${_CURRENT_PHASE} / ${_CURRENT_TEST} ━━━${C_RESET}"
}

_emit_result() {
  local status="$1" details="$2"
  local duration_ms=$(( $(now_ms) - _TEST_START_MS ))
  local escaped_details
  escaped_details="$(json_escape "$details")"
  printf '{"phase":"%s","test":"%s","status":"%s","duration_ms":%d,"started_at":"%s","details":"%s"}\n' \
    "$_CURRENT_PHASE" "$_CURRENT_TEST" "$status" "$duration_ms" \
    "$(date -u -d "@$((_TEST_START_MS / 1000))" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -r $((_TEST_START_MS / 1000)) +%Y-%m-%dT%H:%M:%SZ)" \
    "$escaped_details" >> "$RESULTS_FILE"
  _RESULT_EMITTED=1
}

test_pass() {
  local details="${1:-}"
  echo "${C_GREEN}[PASS]${C_RESET} ${_CURRENT_PHASE}/${_CURRENT_TEST}${details:+ — $details}"
  _emit_result "pass" "$details"
}

test_fail() {
  local details="${1:-}"
  echo "${C_RED}[FAIL]${C_RESET} ${_CURRENT_PHASE}/${_CURRENT_TEST}${details:+ — $details}"
  _emit_result "fail" "$details"
}

# Call from a trap so an unexpected exit (an unset variable, a command
# failing under `set -e` if a script opts into it, Ctrl-C) still produces a
# result line instead of just vanishing from the batch's output — a test
# that errors out is not the same as a test that never ran, and both look
# identical in run-all.sh's summary unless this fires.
test_trap_incomplete() {
  if [ "$_RESULT_EMITTED" -eq 0 ] && [ -n "$_CURRENT_TEST" ]; then
    test_fail "script exited before recording a result (crashed or interrupted)"
  fi
}
