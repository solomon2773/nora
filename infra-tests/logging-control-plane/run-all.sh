#!/usr/bin/env bash
# infra-tests/logging-control-plane/run-all.sh — runs every implemented
# test script in order, writes one combined results/run-<timestamp>.jsonl,
# and prints a summary.
#
# Usage:
#   INFRA_TESTS_CONFIRM=yes-i-know ./run-all.sh                # everything
#   INFRA_TESTS_CONFIRM=yes-i-know ./run-all.sh log-collector   # one test dir
#   INFRA_TESTS_CONFIRM=yes-i-know ./run-all.sh log-collector/01-worker-kill-midwindow.sh
#
# Each script also runs standalone (see any */README.md) — this is a
# convenience wrapper, not the only way to invoke a test. Running a single
# script directly while iterating on it is often faster than re-running
# the whole batch.

set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$ROOT/lib/common.sh"
source "$ROOT/lib/docker_ctl.sh"

require_confirmation

export RESULTS_FILE="$ROOT/results/run-$(date -u +%Y%m%dT%H%M%SZ).jsonl"
: > "$RESULTS_FILE"
log_info "results -> $RESULTS_FILE"

# Collect the set of scripts to run: either everything under phaseN-*/,
# or whatever glob(s) the caller passed (a phase dir, or a specific script).
declare -a targets=()
if [ "$#" -eq 0 ]; then
  while IFS= read -r -d '' f; do targets+=("$f"); done \
    < <(find "$ROOT" -mindepth 2 -maxdepth 2 -type f -name '[0-9][0-9]-*.sh' -print0 | sort -z)
else
  for arg in "$@"; do
    if [ -d "$ROOT/$arg" ]; then
      while IFS= read -r -d '' f; do targets+=("$f"); done \
        < <(find "$ROOT/$arg" -maxdepth 1 -type f -name '[0-9][0-9]-*.sh' -print0 | sort -z)
    elif [ -f "$ROOT/$arg" ]; then
      targets+=("$ROOT/$arg")
    elif [ -f "$arg" ]; then
      targets+=("$arg")
    else
      echo "run-all.sh: no such phase directory or script: $arg" >&2
      exit 2
    fi
  done
fi

if [ "${#targets[@]}" -eq 0 ]; then
  echo "run-all.sh: no test scripts found for: ${*:-(all)}" >&2
  exit 2
fi

log_info "running ${#targets[@]} test script(s)"

pass=0
fail=0
for script in "${targets[@]}"; do
  # Each script owns its own require_confirmation + trap; we already
  # confirmed once above, but re-exporting INFRA_TESTS_CONFIRM lets the
  # child script's own guard pass without prompting a second time.
  if INFRA_TESTS_CONFIRM="$INFRA_TESTS_CONFIRM" RESULTS_FILE="$RESULTS_FILE" bash "$script"; then
    :
  fi
  # Tally from the results file itself rather than the script's exit code —
  # a script can legitimately exit 0 after recording a "fail" result (it
  # completed its assertion, the assertion just didn't hold), and exit
  # code alone would misreport that as a pass.

  # Settle gap before the next script: a script's own cleanup trap can
  # restart worker-provisioner/backend-api (destination restore, cap
  # restore, etc.) right as it exits — with no gap, the NEXT script's own
  # 30s-reconcile-tick timing assumptions (its "sleep 35" after
  # provisioning an agent) start counting against a container that's
  # still mid-restart, silently shortening the real window the collector
  # has to attach. Confirmed as a real source of inter-test flakiness
  # during this suite's development (phase5b's retry-after-failure test
  # passed reliably standalone but intermittently failed only when run
  # right after other phase5b scripts in the same batch). Waiting for
  # health plus a short fixed buffer, rather than a long fixed sleep,
  # keeps this cheap on the common case (service already stable) while
  # still covering the slow case.
  wait_for_healthy worker-provisioner 60 || true
  sleep 5
done

pass="$(grep -c '"status":"pass"' "$RESULTS_FILE" 2>/dev/null || echo 0)"
fail="$(grep -c '"status":"fail"' "$RESULTS_FILE" 2>/dev/null || echo 0)"

echo ""
echo "${C_BOLD}━━━ Summary ━━━${C_RESET}"
echo "${C_GREEN}${pass} passed${C_RESET}, ${C_RED}${fail} failed${C_RESET} — full results: $RESULTS_FILE"

if [ "$fail" -gt 0 ]; then
  echo ""
  echo "Failed:"
  grep '"status":"fail"' "$RESULTS_FILE" | while IFS= read -r line; do
    phase="$(echo "$line" | sed -n 's/.*"phase":"\([^"]*\)".*/\1/p')"
    test="$(echo "$line" | sed -n 's/.*"test":"\([^"]*\)".*/\1/p')"
    echo "  - ${phase}/${test}"
  done
  exit 1
fi
exit 0
