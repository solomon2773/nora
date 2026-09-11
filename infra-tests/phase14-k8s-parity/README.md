# Phase 14 — Kubernetes Parity, Helm, And Local-Driver Hardening

**Plan doc:** "Phase 14: Kubernetes Parity, Helm, And Local-Driver
Hardening" (line 1680).

**Objective:** make the Kubernetes path equivalent to Docker under object
storage, make the unsupported `local` + Kubernetes combination explicit
everywhere it surfaces, harden the `local` driver for its default-install
status, and enforce the single-replica constraint the buffer-ownership
design depends on.

**Code:** `workers/provisioner/backends/k8s.ts` (log tail / `sinceTime`
mapping), `infra/helm/nora/values.yaml`,
`infra/helm/nora/templates/configmap-env.yaml` (the `fail` guards),
`infra/helm/nora/templates/workers.yaml` (`workerProvisioner.replicas`),
`docker-compose.yml` / `docker-compose.override.yml` (`nora_logs` named
volume), `e2e/scripts/run-kind-k8s-smoke.sh`.

**Unit tests:** `workers/provisioner/k8sLogsTail.test.js` exists in this
worktree and covers the `sinceTime`/`tailLines` mapping logic with a fake
Kubernetes API client: omitting `opts.tail` omits `tailLines` entirely
(full available log), an explicit `opts.tail` maps to `tailLines` (the live
viewer's `tail: 100` case), `opts.since` maps to `sinceTime` as RFC3339
(the collector's cursor-replay case), and no-Running-pod returns `null`
rather than throwing or retrying. This is pure request-shape logic against
a mocked client — it does not exercise a real cluster, a real pod
reschedule, or the retry/backoff behavior around repeated `null` results
under real conditions. There is no unit test for the Helm chart's `fail`
guards (`configmap-env.yaml` lines ~31-67: `enabledBackends` must include
`k8s`/exclude `docker`, `NORA_LOG_STORAGE` must not be `local`,
`workerProvisioner.replicas` must stay `1`) or for the Compose
`nora_logs` volume/capacity-halt behavior — none of that is exercised
anywhere except by actually rendering the chart or running the stack, which
is exactly this phase's infra-test surface.

## Test matrix

| # | Test | Description | Status | Notes |
|---|------|-------------|--------|-------|
| 1 | A Kind-deployed agent produces segments against MinIO | Does an agent running in a real Kubernetes cluster (Kind) actually get its logs collected and flushed to real object storage, end to end? | [ ] planned | `e2e/scripts/run-kind-k8s-smoke.sh` already stands up Kind + in-cluster MinIO for the existing k8s smoke path — extend it (per the plan doc) to deploy a real agent, generate log output, and assert segments land in MinIO, rather than writing a fresh cluster bootstrap here. |
| 2 | Pod rescheduling triggers reattach with `sinceTime` and no duplicate ingest | If a pod backing an agent gets rescheduled (new pod, same agent) mid-stream, does the collector pick back up from where it left off — no gap, no re-ingested duplicate lines? | [ ] planned | Needs a real Kind pod, real deletion/reschedule (not a mock), and a way to count/diff ingested lines before and after. The unit test's `sinceTime` mapping is covered; what's untested is whether the real collector actually calls back in with the right cursor after a real reschedule event and dedupes correctly against real timing/ordering. |
| 3 | The chart renders with `s3` and `r2` configurations | Does `helm template`/`helm install` succeed and produce sane manifests when `NORA_LOG_STORAGE` is set to `s3` or to `r2` with matching credentials? | **[x] implemented** — `03-helm-renders-s3-and-r2.sh` | Live-verified pass. No cluster, no docker compose, no auth — pure `helm template` against dummy `secrets.*` values (required by `secret-env.yaml`'s own guards, unrelated to logging) plus the real s3/r2 `backendEnv.NORA_LOG_*` values, asserting a clean render and the expected `NORA_LOG_STORAGE` value in the rendered ConfigMap. |
| 4 | The chart refuses to render with `local`, citing the unsupported combination | Does `helm template`/`helm install` fail fast with a clear message when `NORA_LOG_STORAGE` is `local` (or unset) for the Helm deployment, instead of deploying something broken? | **[x] implemented** — `04-helm-rejects-local-storage.sh` | Live-verified pass, both for `NORA_LOG_STORAGE` unset and explicitly `local`. Asserts against the guard's real text (`must not be "local" (or unset, which defaults to "local") for the Helm deployment`), read directly from `configmap-env.yaml` rather than guessed. |
| 5 | The chart refuses to render with `workerProvisioner.replicas` above `1`, citing the single-buffer-owner constraint | Does `helm template`/`helm install` fail fast when someone sets `workerProvisioner.replicas: 2` (or higher), instead of silently deploying a config that would duplicate/drop log collection? | **[x] implemented** — `05-helm-rejects-multi-replica.sh` | Live-verified pass. Also sanity-checks `replicas=1` (the default) with an otherwise-identical valid s3 config renders cleanly first, so a `replicas=2` failure can't be mistaken for some unrelated config problem. Asserts against the guard's real text (`it must stay 1`). |

**A real bug found while building #3-#5: a `grep -q`/`set -o pipefail` interaction, not caught by the reference suite's own `grep -c` gotcha writeup.** The first draft of each assertion used `echo "$var" | grep -q '...'`. `grep -q` exits as soon as it finds a match, without reading the rest of its input — `echo` then gets `SIGPIPE` trying to write the remainder into the now-closed pipe, so `echo` itself exits non-zero. Under `set -o pipefail` (from `lib/common.sh`), the PIPELINE's exit status becomes `echo`'s non-zero exit, not `grep`'s successful (zero, match-found) one — so `! echo ... | grep -q ...` evaluated as true (failure) even when the pattern genuinely matched. Confirmed by a live run of `03-helm-renders-s3-and-r2.sh`: both renders exited 0 and visibly contained the right `NORA_LOG_STORAGE` line, but the script still reported `[FAIL]` with a "Broken pipe" write error on stderr. Fixed by using a here-string (`grep -q '...' <<<"$var"`) instead of an `echo | grep` pipe — no second process, no SIGPIPE, no pipefail interaction. Worth a pass over the rest of this suite (this pattern doesn't appear in the existing phase3-phase5b reference scripts, but would trip the same way anywhere it's introduced under `set -o pipefail`).
| 6 | Docker Compose with the default (`local`, no credentials) produces searchable segments end to end | Does a fresh `docker compose up -d` with no log-storage configuration at all — the actual out-of-box default — really collect, flush, and make searchable a real agent's logs using the `local` driver? | [ ] planned | Closest in spirit to the full suite's Phase 3/4 tests (real containers, real segment writer) but specifically against the unconfigured default rather than an explicit destination — a good candidate to share fixture/provisioning logic with `logging-integration/infra-tests/phase3-segment-writer/` and `phase4-log-collector/` once merged, rather than duplicating it. |
| 7 | The `nora_logs` volume is readable by `backend-api` under both the dev and prod uid configurations | Does the shared `nora_logs` named volume actually have compatible ownership for `backend-api` to read what `worker-provisioner` wrote, in both `docker-compose.yml` (dev, uid 0:0) and the prod/TLS overlay (uid 1000)? | [ ] planned | Needs two separate compose runs (base dev stack, then the prod overlay) each writing a real segment via `worker-provisioner` and reading it back via `backend-api`, checking for permission errors specifically — a unit test can't observe real volume/uid behavior since it never touches a real Docker volume. |
| 8 | The capacity halt keeps usage from exceeding the cap on an undersized volume, halts collection installation-wide (not per-workspace), and a workspace uninvolved in filling it still loses collection for the duration | Under a deliberately tiny `NORA_LOG_LOCAL_MAX_BYTES`, does log collection actually stop once the volume fills — for every workspace, including ones that had nothing to do with filling it — rather than silently exceeding the cap or deleting data? | [ ] planned | Same shape as the full suite's Phase 5 capacity-halt tests (see `logging-integration/infra-tests/phase5-retention-sweeper/` and its `lib/local_cap.sh` helper, which already documents the gotcha that changing `NORA_LOG_LOCAL_MAX_BYTES` requires recreating, not restarting, the containers). This phase's addition is specifically checking the installation-wide (not per-workspace) scope of the halt using two real agents in two different workspaces. |
| 9 | Changing the destination from `local` to `s3` on a running Compose stack leaves prior segments readable | If an operator switches `NORA_LOG_STORAGE` from `local` to `s3` on an already-running stack (not a fresh install), can they still read/search log segments that were written before the switch? | [ ] planned | Real migration-adjacent scenario, likely reusing (not duplicating) `logging-integration/infra-tests/phase5b-storage-migration/`'s quarantine-based isolation and MinIO helpers once merged — write real segments under `local`, flip the destination, confirm search/read against the old segments still works without requiring an explicit migration job to have run first. |

This phase is squarely infra-chaos-shaped (Kind cluster, Helm render
assertions, real Docker volume ownership, real capacity-halt behavior) —
closer in spirit to the full suite's Phases 3-5b than to 6/7. Tests #1-#2
need a real Kind cluster (`e2e/scripts/run-kind-k8s-smoke.sh` is the
existing precedent to extend, not replace); #3-#5 need only `helm
template`/`helm lint` and no cluster at all, making them the cheapest
starting point for real numbered scripts; #6-#9 need a real
`docker-compose` stack and, for #7, two separate stack configurations.
Flag this phase as the natural next one to get real numbered scripts after
merging into the full suite, given how much of it is genuinely
infra-shaped rather than request/response logic.

## Blocked on

#3-#5 are done (see table above) — they needed nothing but `helm template`
and are now implemented and live-verified. #1-#2 need a real Kind cluster
(extending `e2e/scripts/run-kind-k8s-smoke.sh`) and are left `[ ] planned`
as genuinely out of scope for this pass, per this worktree's task brief.

#6-#9 need a live `docker compose` stack, and were deliberately left
`[ ] planned` rather than attempted this pass — not because the shared
`lib/` helpers are missing (they're in place now, copied byte-for-byte
from `logging-integration/infra-tests/lib/`), but because of a real,
serious finding surfaced while validating Phase 5c's scripts against this
same stack: **this worktree's docker-compose project is not isolated from
other worktrees.** `COMPOSE_PROJECT_NAME=nora` is identical across this
worktree's and `logging-integration`'s `.env` files, so `docker compose`
commands issued from here operate on the SAME running containers another
worktree's session may be actively using — confirmed directly: running
one Phase 5c script from here caused Compose to detect config drift and
recreate `postgres`/`redis`/`backend-api`/`worker-provisioner`, and a
concurrently-running test agent belonging to what looks like
`logging-integration`'s own `phase5b-storage-migration` suite was observed
live in the DB and `docker ps` mid-session. See
`phase5c-deletion-recovery/README.md`'s "Blocked on" section for the full
account. Rows #6-#9 (real Compose stack, `nora_logs` volume ownership,
capacity halt across two real agents/workspaces) would all multiply this
exposure — real containers restarted, real `NORA_LOG_LOCAL_MAX_BYTES`
env-var flips requiring container recreation (see `lib/local_cap.sh`) —
so building them out was deliberately deferred rather than risking a
second worktree's concurrent chaos run. This is a suite-wide
infrastructure gap (a per-worktree `COMPOSE_PROJECT_NAME` would fix it)
worth resolving before more than one agent/session runs
docker-compose-touching infra-tests scripts at the same time, not
something specific to Phase 14's rows.
